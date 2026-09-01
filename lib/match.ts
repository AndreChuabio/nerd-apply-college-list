// Deterministic college matcher for the report pipeline.
//
// Two-stage design, both stages fully explainable:
//   1. Bucketing: an academic index for the student is compared against each
//      school's middle 50 percent test window to label it reach, target, or
//      likely. Hard floor: any school admitting under 15 percent is a reach.
//   2. Fit score: preference components (program, geography, size, cost,
//      learning style) order schools inside each bucket.
//
// Every number quoted in a ScoreComponent comes from the college row or the
// student profile. Nothing here calls a model or invents data. Static lookup
// tables (state names, adjacency, warm states, interest to CIP mapping) live
// at the bottom of the file.

import type {
  Bucket,
  College,
  ProgramArea,
  ScoreComponent,
  ScoredCollege,
  SizePreference,
  StudentProfile,
} from "./types";

export interface MatchResult {
  reach: ScoredCollege[];
  target: ScoredCollege[];
  likely: ScoredCollege[];
}

const BUCKET_LIMIT = 4;
const FORCED_REACH_ADMIT_RATE = 0.15;
const ACADEMIC_LABEL = "Academic fit";
const PROGRAM_LABEL = "Program fit";

// ---------- ACT to SAT concordance ----------

// Anchor points from the official 2018 ACT/SAT concordance. Scores between
// anchors are linearly interpolated; below the lowest anchor the first
// segment's slope extends the line, floored at the 400 SAT minimum.
const ACT_SAT_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [18, 960],
  [24, 1160],
  [30, 1360],
  [36, 1590],
];

export function actToSat(act: number): number {
  const clamped = Math.min(36, Math.max(1, act));
  const [firstAct, firstSat] = ACT_SAT_ANCHORS[0];
  if (clamped <= firstAct) {
    const [secondAct, secondSat] = ACT_SAT_ANCHORS[1];
    const slope = (secondSat - firstSat) / (secondAct - firstAct);
    return Math.max(400, Math.round(firstSat + (clamped - firstAct) * slope));
  }
  for (let i = 1; i < ACT_SAT_ANCHORS.length; i += 1) {
    const [hiAct, hiSat] = ACT_SAT_ANCHORS[i];
    if (clamped <= hiAct) {
      const [loAct, loSat] = ACT_SAT_ANCHORS[i - 1];
      const t = (clamped - loAct) / (hiAct - loAct);
      return Math.round(loSat + t * (hiSat - loSat));
    }
  }
  return ACT_SAT_ANCHORS[ACT_SAT_ANCHORS.length - 1][1];
}

// ---------- Student academic index ----------

interface AcademicIndex {
  value: number;
  // Noun phrase reused in component details, e.g. "your 1230 SAT".
  phrase: string;
}

function computeAcademicIndex(profile: StudentProfile): AcademicIndex | null {
  let base: number | null = null;
  let phrase = "";
  if (profile.satTotal !== null) {
    base = profile.satTotal;
    phrase = `your ${profile.satTotal} SAT`;
  } else if (profile.actComposite !== null) {
    base = actToSat(profile.actComposite);
    phrase = `your ${profile.actComposite} ACT (about ${base} on the SAT scale)`;
  }
  if (base === null) {
    return null;
  }
  // Heuristic GPA nudge: a strong GPA lifts the index slightly and a weak one
  // lowers it, so grades matter without overwhelming the test score.
  let value = base;
  if (profile.gpa !== null && profile.gpa > 3.7) {
    value = base + 30;
    phrase = `${phrase} (nudged to ${value} for your ${profile.gpa} GPA)`;
  } else if (profile.gpa !== null && profile.gpa < 3.0) {
    value = base - 30;
    phrase = `${phrase} (nudged to ${value} for your ${profile.gpa} GPA)`;
  }
  return { value, phrase };
}

// ---------- School middle 50 percent window ----------

interface MidFiftyWindow {
  low: number;
  high: number;
  estimatedFromAct: boolean;
}

function midFiftyWindow(college: College): MidFiftyWindow | null {
  const { satReading25, satReading75, satMath25, satMath75 } = college;
  if (
    satReading25 !== null &&
    satMath25 !== null &&
    satReading75 !== null &&
    satMath75 !== null
  ) {
    return {
      low: satReading25 + satMath25,
      high: satReading75 + satMath75,
      estimatedFromAct: false,
    };
  }
  if (college.actComposite25 !== null && college.actComposite75 !== null) {
    return {
      low: actToSat(college.actComposite25),
      high: actToSat(college.actComposite75),
      estimatedFromAct: true,
    };
  }
  return null;
}

// ---------- Bucketing ----------

interface BucketDecision {
  bucket: Bucket;
  detail: string;
}

function decideBucket(
  index: AcademicIndex | null,
  window: MidFiftyWindow | null,
  college: College
): BucketDecision {
  const rate = college.admitRate;

  // Hard rule: single-digit-ish admit rates are a reach for every applicant,
  // regardless of how strong the student's numbers are.
  if (rate !== null && rate < FORCED_REACH_ADMIT_RATE) {
    return {
      bucket: "reach",
      detail: `An admit rate of ${asPercent(rate)} percent makes this a reach for every applicant.`,
    };
  }

  if (index !== null && window !== null) {
    const rangeText = window.estimatedFromAct
      ? `${window.low} to ${window.high} (estimated from its ACT range)`
      : `${window.low} to ${window.high}`;
    if (index.value < window.low) {
      return {
        bucket: "reach",
        detail: toSentence(`${index.phrase} sits below its middle 50 percent range of ${rangeText}`),
      };
    }
    if (index.value > window.high) {
      return {
        bucket: "likely",
        detail: toSentence(`${index.phrase} sits above its middle 50 percent range of ${rangeText}`),
      };
    }
    return {
      bucket: "target",
      detail: toSentence(`${index.phrase} sits inside its middle 50 percent range of ${rangeText}`),
    };
  }

  // Fallback: no comparable test data on one side or the other, so band on
  // admit rate alone and say so.
  if (rate === null) {
    return {
      bucket: "target",
      detail: "No admit rate or test range data is available, so this school defaults to the target list.",
    };
  }
  const reason =
    index === null
      ? "No test scores were provided"
      : "This school reports no test score ranges";
  const bucket: Bucket = rate < 0.25 ? "reach" : rate <= 0.6 ? "target" : "likely";
  return {
    bucket,
    detail: `${reason}, so it is bucketed on its ${asPercent(rate)} percent admit rate alone.`,
  };
}

// ---------- Fit score components ----------

function programComponent(profile: StudentProfile, college: College): ScoreComponent | null {
  const interests = profile.interests.filter(
    (interest): interest is Exclude<ProgramArea, "undecided"> => interest !== "undecided"
  );
  if (interests.length === 0) {
    return null;
  }
  let bestLabel = "";
  let bestShare = -1;
  for (const interest of interests) {
    const mapping = INTEREST_PROGRAMS[interest];
    const share = mapping.cipKeys.reduce(
      (sum, key) => sum + (college.programShares[key] ?? 0),
      0
    );
    if (share > bestShare) {
      bestShare = share;
      bestLabel = mapping.label;
    }
  }
  if (bestShare < 0.005) {
    return {
      label: PROGRAM_LABEL,
      detail: "Few degrees here are in your listed interest areas.",
      points: 0,
    };
  }
  const pct = Math.round(bestShare * 100);
  return {
    label: PROGRAM_LABEL,
    detail: `${capitalize(bestLabel)} accounts for ${pct} percent of degrees at this school.`,
    points: Math.min(40, pct),
  };
}

function geographyComponents(profile: StudentProfile, college: College): ScoreComponent[] {
  const out: ScoreComponent[] = [];
  const schoolState = college.state.toUpperCase();
  const schoolName = stateName(schoolState);
  if (profile.prefersNearHome && profile.homeState !== null) {
    const home = profile.homeState.toUpperCase();
    const homeName = stateName(home);
    if (schoolState === home) {
      out.push({
        label: "Location",
        detail: `Located in ${schoolName}, your home state.`,
        points: 25,
      });
    } else if ((STATE_ADJACENCY[home] ?? []).includes(schoolState)) {
      out.push({
        label: "Location",
        detail: `Located in ${schoolName}, one state over from your home state of ${homeName}.`,
        points: 12,
      });
    } else {
      out.push({
        label: "Location",
        detail: `Located in ${schoolName}, a long way from your home state of ${homeName}.`,
        points: -8,
      });
    }
  }
  if (profile.prefersWarmClimate && WARM_STATES.has(schoolState)) {
    out.push({
      label: "Climate",
      detail: `Its ${schoolName} location fits your warm climate preference.`,
      points: 10,
    });
  }
  return out;
}

function sizeComponent(profile: StudentProfile, college: College): ScoreComponent | null {
  if (profile.sizePreference === null || college.undergradSize === null) {
    return null;
  }
  const size = college.undergradSize;
  const band: SizePreference = size < 5000 ? "small" : size <= 15000 ? "medium" : "large";
  if (band !== profile.sizePreference) {
    return null;
  }
  return {
    label: "Campus size",
    detail: `Undergraduate enrollment of ${size.toLocaleString("en-US")} matches your preference for a ${band} school.`,
    points: 10,
  };
}

function costComponent(profile: StudentProfile, college: College): ScoreComponent | null {
  if (profile.needsFinancialAid === false) {
    return null;
  }
  const price = college.avgNetPrice;
  if (price === null) {
    return {
      label: "Cost",
      detail: "No average net price is reported, which makes affordability hard to judge.",
      points: -3,
    };
  }
  const points = price <= 12000 ? 15 : price <= 22000 ? 10 : price <= 32000 ? 5 : 0;
  const priceText = `$${price.toLocaleString("en-US")} per year`;
  if (points === 0) {
    return {
      label: "Cost",
      detail: `Average net price of ${priceText} is on the high side for a financial aid budget.`,
      points,
    };
  }
  return {
    label: "Cost",
    detail: `Average net price of ${priceText} works in your favor given your financial aid needs.`,
    points,
  };
}

function learningStyleComponent(profile: StudentProfile, college: College): ScoreComponent | null {
  if (profile.learningStyle !== "hands-on") {
    return null;
  }
  // Proxy, stated as such: schools graduating many engineering and computing
  // majors tend to run more applied, lab-heavy programs.
  const combined =
    (college.programShares.pcip11 ?? 0) +
    (college.programShares.pcip14 ?? 0) +
    (college.programShares.pcip15 ?? 0);
  if (combined < 0.08) {
    return null;
  }
  return {
    label: "Hands-on orientation",
    detail: `About ${Math.round(combined * 100)} percent of degrees are in engineering and technology fields, a rough proxy for hands-on learning.`,
    points: combined >= 0.2 ? 10 : 5,
  };
}

// ---------- Scoring and selection ----------

function scoreCollege(
  profile: StudentProfile,
  index: AcademicIndex | null,
  college: College
): ScoredCollege {
  const window = midFiftyWindow(college);
  const decision = decideBucket(index, window, college);
  const components: ScoreComponent[] = [
    { label: ACADEMIC_LABEL, detail: decision.detail, points: 0 },
  ];
  const candidates = [
    programComponent(profile, college),
    ...geographyComponents(profile, college),
    sizeComponent(profile, college),
    costComponent(profile, college),
    learningStyleComponent(profile, college),
  ];
  for (const component of candidates) {
    if (component !== null) {
      components.push(component);
    }
  }
  const score = components.reduce((sum, component) => sum + component.points, 0);
  return {
    college,
    bucket: decision.bucket,
    score,
    components,
    rationale: "",
    rationaleSource: "fallback",
  };
}

function byFit(a: ScoredCollege, b: ScoredCollege): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const gradA = a.college.gradRate ?? -1;
  const gradB = b.college.gradRate ?? -1;
  if (gradB !== gradA) {
    return gradB - gradA;
  }
  return a.college.name.localeCompare(b.college.name);
}

function admitRateOf(scored: ScoredCollege): number {
  return scored.college.admitRate ?? 0.5;
}

// Which donor entry reads most like a member of the empty bucket: the most
// selective school for a reach, the least selective for a likely, and the
// middle of the road for a target.
function pickBorderline(donor: ScoredCollege[], bucket: Bucket): number {
  let bestIdx = 0;
  let bestRate = admitRateOf(donor[0]);
  for (let i = 1; i < donor.length; i += 1) {
    const rate = admitRateOf(donor[i]);
    const better =
      bucket === "reach"
        ? rate < bestRate
        : bucket === "likely"
          ? rate > bestRate
          : Math.abs(rate - 0.5) < Math.abs(bestRate - 0.5);
    if (better) {
      bestIdx = i;
      bestRate = rate;
    }
  }
  return bestIdx;
}

// A student report should never show an empty column while candidates exist,
// so an empty bucket borrows one or two borderline schools from a neighboring
// bucket, relabeled with an honest note. Donors are never emptied.
function fillEmptyBuckets(lists: Record<Bucket, ScoredCollege[]>): void {
  const donorPreference: Record<Bucket, Bucket[]> = {
    reach: ["target", "likely"],
    target: ["likely", "reach"],
    likely: ["target", "reach"],
  };
  for (const bucket of ["reach", "target", "likely"] as const) {
    if (lists[bucket].length > 0) {
      continue;
    }
    for (const donorName of donorPreference[bucket]) {
      const donor = lists[donorName];
      while (donor.length > 1 && lists[bucket].length < 2) {
        const [moved] = donor.splice(pickBorderline(donor, bucket), 1);
        moved.bucket = bucket;
        moved.components.push({
          label: "List balancing",
          detail: `Moved from the ${donorName} list so the ${bucket} list is not empty; by the numbers this school is a ${donorName}.`,
          points: 0,
        });
        lists[bucket].push(moved);
        if (donor.length <= 2) {
          break;
        }
      }
      if (lists[bucket].length > 0) {
        break;
      }
    }
    lists[bucket].sort(byFit);
  }
}

export function matchColleges(profile: StudentProfile, colleges: College[]): MatchResult {
  const index = computeAcademicIndex(profile);
  const lists: Record<Bucket, ScoredCollege[]> = { reach: [], target: [], likely: [] };
  for (const college of colleges) {
    const scored = scoreCollege(profile, index, college);
    lists[scored.bucket].push(scored);
  }
  for (const bucket of ["reach", "target", "likely"] as const) {
    lists[bucket].sort(byFit);
  }
  fillEmptyBuckets(lists);
  const result: MatchResult = {
    reach: lists.reach.slice(0, BUCKET_LIMIT),
    target: lists.target.slice(0, BUCKET_LIMIT),
    likely: lists.likely.slice(0, BUCKET_LIMIT),
  };
  for (const list of [result.reach, result.target, result.likely]) {
    for (const scored of list) {
      scored.rationale = buildFallbackRationale(scored, profile);
    }
  }
  return result;
}

// ---------- Fallback rationale ----------

// Assembles one to two grounded sentences from the score components. Used
// verbatim when the Gemini prose step is unavailable, so it must stand on its
// own. Leads with the program fit when the student declared an interest,
// otherwise with the strongest preference component, then closes with the
// academic placement sentence.
export function buildFallbackRationale(scored: ScoredCollege, profile: StudentProfile): string {
  const academic = scored.components.find((c) => c.label === ACADEMIC_LABEL);
  const fits = scored.components
    .filter((c) => c.label !== ACADEMIC_LABEL && c.points > 0)
    .sort((a, b) => b.points - a.points);
  const hasDeclaredInterest = profile.interests.some((i) => i !== "undecided");
  const programFit = fits.find((c) => c.label === PROGRAM_LABEL);
  const lead = hasDeclaredInterest && programFit !== undefined ? programFit : fits[0];
  const sentences: string[] = [];
  if (lead !== undefined) {
    sentences.push(lead.detail);
  }
  if (academic !== undefined) {
    sentences.push(academic.detail);
  }
  if (sentences.length === 0) {
    sentences.push(`${scored.college.name} lands on the ${scored.bucket} list based on the data available.`);
  }
  return sentences.slice(0, 2).join(" ");
}

// ---------- Small helpers ----------

function asPercent(rate: number): number {
  return Math.round(rate * 100);
}

function toSentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function stateName(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code;
}

// ---------- Static lookup tables ----------

interface InterestMapping {
  label: string;
  cipKeys: string[];
}

// Two-digit CIP families keyed by the student-facing interest vocabulary.
// Marine biology credits both biological sciences (26) and natural resources
// (03), where marine and aquatic programs are classified.
const INTEREST_PROGRAMS: Record<Exclude<ProgramArea, "undecided">, InterestMapping> = {
  "computer-science": { label: "computer science", cipKeys: ["pcip11"] },
  engineering: { label: "engineering", cipKeys: ["pcip14", "pcip15"] },
  biology: { label: "biology", cipKeys: ["pcip26"] },
  "marine-biology": { label: "marine biology", cipKeys: ["pcip26", "pcip03"] },
  "natural-resources": { label: "natural resources", cipKeys: ["pcip03"] },
  business: { label: "business", cipKeys: ["pcip52"] },
  health: { label: "health professions", cipKeys: ["pcip51"] },
  psychology: { label: "psychology", cipKeys: ["pcip42"] },
  "visual-performing-arts": { label: "visual and performing arts", cipKeys: ["pcip50"] },
  mathematics: { label: "mathematics", cipKeys: ["pcip27"] },
  "physical-sciences": { label: "physical sciences", cipKeys: ["pcip40"] },
  "social-sciences": { label: "social sciences", cipKeys: ["pcip45"] },
  english: { label: "English", cipKeys: ["pcip23"] },
  history: { label: "history", cipKeys: ["pcip54"] },
  education: { label: "education", cipKeys: ["pcip13"] },
  communications: { label: "communications", cipKeys: ["pcip09"] },
};

const WARM_STATES: ReadonlySet<string> = new Set([
  "FL", "GA", "SC", "NC", "CA", "AZ", "NM", "TX", "LA", "MS", "AL", "HI", "NV",
]);

// Land-border adjacency for the lower 48 plus DC. AK and HI border nothing.
const STATE_ADJACENCY: Record<string, string[]> = {
  AL: ["FL", "GA", "MS", "TN"],
  AK: [],
  AZ: ["CA", "CO", "NM", "NV", "UT"],
  AR: ["LA", "MO", "MS", "OK", "TN", "TX"],
  CA: ["AZ", "NV", "OR"],
  CO: ["AZ", "KS", "NE", "NM", "OK", "UT", "WY"],
  CT: ["MA", "NY", "RI"],
  DE: ["MD", "NJ", "PA"],
  DC: ["MD", "VA"],
  FL: ["AL", "GA"],
  GA: ["AL", "FL", "NC", "SC", "TN"],
  HI: [],
  ID: ["MT", "NV", "OR", "UT", "WA", "WY"],
  IL: ["IA", "IN", "KY", "MO", "WI"],
  IN: ["IL", "KY", "MI", "OH"],
  IA: ["IL", "MN", "MO", "NE", "SD", "WI"],
  KS: ["CO", "MO", "NE", "OK"],
  KY: ["IL", "IN", "MO", "OH", "TN", "VA", "WV"],
  LA: ["AR", "MS", "TX"],
  ME: ["NH"],
  MD: ["DC", "DE", "PA", "VA", "WV"],
  MA: ["CT", "NH", "NY", "RI", "VT"],
  MI: ["IN", "OH", "WI"],
  MN: ["IA", "ND", "SD", "WI"],
  MS: ["AL", "AR", "LA", "TN"],
  MO: ["AR", "IA", "IL", "KS", "KY", "NE", "OK", "TN"],
  MT: ["ID", "ND", "SD", "WY"],
  NE: ["CO", "IA", "KS", "MO", "SD", "WY"],
  NV: ["AZ", "CA", "ID", "OR", "UT"],
  NH: ["MA", "ME", "VT"],
  NJ: ["DE", "NY", "PA"],
  NM: ["AZ", "CO", "OK", "TX"],
  NY: ["CT", "MA", "NJ", "PA", "VT"],
  NC: ["GA", "SC", "TN", "VA"],
  ND: ["MN", "MT", "SD"],
  OH: ["IN", "KY", "MI", "PA", "WV"],
  OK: ["AR", "CO", "KS", "MO", "NM", "TX"],
  OR: ["CA", "ID", "NV", "WA"],
  PA: ["DE", "MD", "NJ", "NY", "OH", "WV"],
  RI: ["CT", "MA"],
  SC: ["GA", "NC"],
  SD: ["IA", "MN", "MT", "ND", "NE", "WY"],
  TN: ["AL", "AR", "GA", "KY", "MO", "MS", "NC", "VA"],
  TX: ["AR", "LA", "NM", "OK"],
  UT: ["AZ", "CO", "ID", "NV", "WY"],
  VT: ["MA", "NH", "NY"],
  VA: ["DC", "KY", "MD", "NC", "TN", "WV"],
  WA: ["ID", "OR"],
  WV: ["KY", "MD", "OH", "PA", "VA"],
  WI: ["IA", "IL", "MI", "MN"],
  WY: ["CO", "ID", "MT", "NE", "SD", "UT"],
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "the District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", PR: "Puerto Rico",
};
