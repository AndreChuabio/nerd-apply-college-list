// Anti-fabrication guardrail for model-written prose.
//
// A wrong number in a student's college list is a real harm: a family can plan
// around a net price or an admit rate that the school never reported. Prompting
// reduces that risk but does not bound it, so every rationale is checked
// mechanically before it reaches a report.
//
// The rule is deliberately narrow and cheap: a rationale may only contain
// numbers the underlying data can account for. Anything else means the model
// computed, rounded, or invented a figure, and the caller replaces the prose
// with the deterministic fallback rather than trying to repair it.
//
// Known limit, stated plainly: this checks numeric claims, not qualitative
// ones. "A strong reputation for undergraduate teaching" is unverifiable here
// and is handled by the prompt, not by this function.

import type { College, StudentProfile } from "@/lib/types";

/**
 * Scaffolding numbers that can describe how the data is reported rather than
 * making a claim about a school: percentile boundaries, the percent scale, the
 * four-year graduation window, and the ten-year earnings horizon.
 *
 * They are only exempt in those scaffolding contexts. Outside them, "ranked
 * 4th" or "a top 25 program" is a claim like any other and must be justified
 * by the allowed data set.
 */
const STRUCTURAL_NUMBERS: ReadonlySet<number> = new Set([4, 10, 25, 50, 75, 100]);

/** Percent or percentile right after the number: "25th percentile", "50 percent", "100%". */
const PERCENT_CONTEXT_AFTER = /^(?:st|nd|rd|th)?\s*(?:%|percent(?:ile)?\b)/i;
/** A reporting window right after the number: "4-year graduation", "10-year earnings". */
const YEAR_CONTEXT_AFTER = /^[\s-]*year\b/i;
/** "middle 50" right before the number. */
const MIDDLE_CONTEXT_BEFORE = /\bmiddle\s+$/i;

/**
 * Decides whether one occurrence of a structural number is scaffolding.
 *
 * @param value The parsed number.
 * @param before The prose immediately preceding the number.
 * @param after The prose immediately following the digits.
 */
function isScaffoldingUse(value: number, before: string, after: string): boolean {
  if (!STRUCTURAL_NUMBERS.has(value)) return false;
  if (PERCENT_CONTEXT_AFTER.test(after)) return true;
  if ((value === 4 || value === 10) && YEAR_CONTEXT_AFTER.test(after)) return true;
  if (value === 50 && MIDDLE_CONTEXT_BEFORE.test(before)) return true;
  return false;
}

/**
 * Matches a number and an optional suffix.
 *   group 1: digits with optional thousands commas and optional decimals
 *   group 2: an attached ordinal suffix, or a "k" thousands shorthand
 *   group 3: a percent sign, optionally separated by a space
 */
const NUMBER_TOKEN = /(\d[\d,]*(?:\.\d+)?)(st|nd|rd|th|k|K)?\b\s*(%)?/g;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pulls every numeric value out of a grounding detail string.
 *
 * Used only to widen the allowed set with figures the scorer already computed
 * and showed the model. The published prose itself is scanned in place by
 * validateRationale so each occurrence keeps its surrounding context.
 */
function extractNumbers(prose: string): number[] {
  const found: number[] = [];
  NUMBER_TOKEN.lastIndex = 0;

  for (let match = NUMBER_TOKEN.exec(prose); match !== null; match = NUMBER_TOKEN.exec(prose)) {
    const digits = match[1].replace(/,/g, "");
    const parsed = Number(digits);
    if (!Number.isFinite(parsed)) continue;

    const suffix = (match[2] ?? "").toLowerCase();
    found.push(suffix === "k" ? parsed * 1000 : parsed);
  }

  return found;
}

/**
 * Records one permitted value.
 *
 * Large magnitudes also admit their nearest-hundred and nearest-thousand
 * rounding. Prose that says "about $21,000" against a reported 21,350 is
 * rounding, not fabricating, and rejecting it would push every money sentence
 * onto the fallback path for no safety gain.
 */
function allowValue(allowed: Set<number>, value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return;

  allowed.add(round2(value));
  allowed.add(Math.round(value));

  if (Math.abs(value) >= 1000) {
    allowed.add(Math.round(value / 100) * 100);
    allowed.add(Math.round(value / 1000) * 1000);
  }
}

/** Records a 0-1 rate in both its decimal and whole-percent forms. */
function allowRate(allowed: Set<number>, rate: number | null): void {
  if (rate === null || !Number.isFinite(rate)) return;
  allowed.add(round2(rate));
  allowed.add(round2(rate * 100));
  allowed.add(Math.round(rate * 100));
}

/** Records the sum of an SAT section pair, which is how a total range is quoted. */
function allowSatWindow(allowed: Set<number>, reading: number | null, math: number | null): void {
  if (reading === null || math === null) return;
  allowValue(allowed, reading + math);
}

/**
 * Every number a rationale about this school, for this student, may contain.
 *
 * unitId and locale are excluded on purpose. They are identifiers and codes,
 * never facts a rationale should cite, and admitting them would widen the set
 * for nothing.
 */
function buildAllowedNumbers(
  college: College,
  profile: StudentProfile,
  groundingDetails: readonly string[],
): Set<number> {
  const allowed = new Set<number>();

  allowRate(allowed, college.admitRate);
  allowRate(allowed, college.gradRate);

  allowValue(allowed, college.satReading25);
  allowValue(allowed, college.satReading75);
  allowValue(allowed, college.satMath25);
  allowValue(allowed, college.satMath75);
  allowValue(allowed, college.satAvg);
  allowSatWindow(allowed, college.satReading25, college.satMath25);
  allowSatWindow(allowed, college.satReading75, college.satMath75);

  allowValue(allowed, college.actComposite25);
  allowValue(allowed, college.actComposite75);
  allowValue(allowed, college.actCompositeMid);

  allowValue(allowed, college.tuitionInState);
  allowValue(allowed, college.tuitionOutOfState);
  allowValue(allowed, college.avgNetPrice);
  allowValue(allowed, college.undergradSize);
  allowValue(allowed, college.medianEarnings10yr);

  // Program shares reach the prompt through the score-component details, so a
  // rationale can legitimately quote one as a percentage.
  for (const share of Object.values(college.programShares)) {
    allowRate(allowed, share);
  }

  allowValue(allowed, profile.satTotal);
  allowValue(allowed, profile.actComposite);
  allowValue(allowed, profile.gpa);

  // Numbers the scorer already computed and handed to the model, such as
  // "about 40 percent of degrees are in engineering and technology fields".
  // These are derived deterministically from the college row, so the model
  // repeating one is quoting, not fabricating. Without this the guardrail
  // would reject its own grounding data whenever the scorer aggregates
  // several fields into a single figure.
  for (const detail of groundingDetails) {
    for (const value of extractNumbers(detail)) {
      allowValue(allowed, value);
    }
  }

  return allowed;
}

/**
 * Decides whether model-written prose is safe to publish for this school.
 *
 * @param prose The rationale returned by the model.
 * @param college The school the rationale describes.
 * @param profile The student the rationale is written for.
 * @param groundingDetails Score-component detail strings that were supplied to
 *        the model for this school. Optional: omitting them only makes the
 *        check stricter, never less safe.
 * @returns True when every number in the prose is accounted for by the data.
 *          False means the caller must substitute the deterministic fallback.
 */
export function validateRationale(
  prose: string,
  college: College,
  profile: StudentProfile,
  groundingDetails: readonly string[] = [],
): boolean {
  if (typeof prose !== "string") return false;

  const trimmed = prose.trim();
  if (trimmed.length === 0) return false;

  // House style, enforced mechanically rather than hoped for in the prompt.
  if (trimmed.includes("!")) return false;

  const allowed = buildAllowedNumbers(college, profile, groundingDetails);

  // Scanned in place rather than through extractNumbers so each occurrence
  // keeps its context: a structural number is only exempt where the
  // surrounding text shows it is scaffolding, not a claim.
  NUMBER_TOKEN.lastIndex = 0;
  for (let match = NUMBER_TOKEN.exec(trimmed); match !== null; match = NUMBER_TOKEN.exec(trimmed)) {
    const digits = match[1].replace(/,/g, "");
    const parsed = Number(digits);
    if (!Number.isFinite(parsed)) continue;

    const suffix = (match[2] ?? "").toLowerCase();
    const value = suffix === "k" ? parsed * 1000 : parsed;
    if (allowed.has(round2(value))) continue;

    const before = trimmed.slice(Math.max(0, match.index - 16), match.index);
    const after = trimmed.slice(match.index + match[1].length);
    if (isScaffoldingUse(value, before, after)) continue;

    return false;
  }

  return true;
}

// ---------- Self-test ----------
//
// Kept in this module rather than a separate spec file so the rules and their
// cases stay together. Run with:
//   npx tsx -e "import('./lib/guardrail.ts').then(m => console.log(m.selfTestGuardrail()))"

const FIXTURE_COLLEGE: College = {
  unitId: 999999,
  name: "Example State University",
  city: "Springfield",
  state: "PA",
  control: "public",
  admitRate: 0.52,
  satReading25: 580,
  satReading75: 670,
  satMath25: 600,
  satMath75: 710,
  satAvg: 1280,
  // Deliberately not 25: the top-25 rejection case below must exercise the
  // scaffolding rule, not be excused by a real data value.
  actComposite25: 24,
  actComposite75: 31,
  actCompositeMid: 28,
  tuitionInState: 18400,
  tuitionOutOfState: 36800,
  avgNetPrice: 21350,
  undergradSize: 24500,
  locale: 13,
  gradRate: 0.68,
  medianEarnings10yr: 62100,
  programShares: { pcip11: 0.09 },
};

const FIXTURE_PROFILE: StudentProfile = {
  name: "John Smith",
  gpa: 3.5,
  satTotal: 1230,
  actComposite: null,
  interests: ["computer-science"],
  homeState: "PA",
  prefersNearHome: true,
  prefersWarmClimate: false,
  sizePreference: null,
  learningStyle: "hands-on",
  needsFinancialAid: false,
  narrativeHighlights: ["won the Congressional App Challenge for Pennsylvania"],
};

interface GuardrailCase {
  description: string;
  prose: string;
  expected: boolean;
}

const CASES: readonly GuardrailCase[] = [
  {
    description: "prose with no numbers is always allowed",
    prose:
      "This campus lines up with your interest in computer science and your preference to stay in Pennsylvania. The engineering culture rewards building over theory.",
    expected: true,
  },
  {
    description: "a reported net price is allowed",
    prose: "The average net price is about $21,350 per year. That keeps cost predictable for you.",
    expected: true,
  },
  {
    description: "an admit rate quoted as a percent is allowed",
    prose: "Roughly 52% of applicants are admitted. Your record puts you inside that range.",
    expected: true,
  },
  {
    description: "an admit rate the school never reported is rejected",
    prose: "Roughly 18% of applicants are admitted. That makes this a stretch.",
    expected: false,
  },
  {
    description: "an SAT window quoted as a total range is allowed",
    prose:
      "The middle 50 percent SAT range here is 1180 to 1380. You would land comfortably inside it.",
    expected: true,
  },
  {
    description: "the student's own score is allowed",
    prose: "Your 1230 SAT sits inside their middle 50 percent. The fit on academics is solid.",
    expected: true,
  },
  {
    description: "an invented ranking is rejected",
    prose: "Example State is ranked 12th nationally. That reputation carries weight.",
    expected: false,
  },
  {
    description: "a structural number outside scaffolding context is rejected",
    prose: "This is a top 25 program in the country. That standing shows in its outcomes.",
    expected: false,
  },
  {
    description: "a percentile boundary in scaffolding context is allowed",
    prose: "Its 75th percentile SAT total is 1380. Your score approaches that mark.",
    expected: true,
  },
  {
    description: "an exclamation mark is rejected on style",
    prose: "This one is a strong match for you. Worth a close look.!",
    expected: false,
  },
];

/**
 * Runs the guardrail cases.
 *
 * @returns The number of passing cases and a description of each failure.
 */
export function selfTestGuardrail(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];

  for (const testCase of CASES) {
    const actual = validateRationale(testCase.prose, FIXTURE_COLLEGE, FIXTURE_PROFILE);
    if (actual !== testCase.expected) {
      failures.push(`${testCase.description}: expected ${testCase.expected}, got ${actual}`);
    }
  }

  // Empty and whitespace-only prose must never publish.
  for (const empty of ["", "   "]) {
    if (validateRationale(empty, FIXTURE_COLLEGE, FIXTURE_PROFILE)) {
      failures.push("empty prose was accepted");
    }
  }

  // A figure the scorer aggregated across several fields is quotable only when
  // that detail was actually supplied as grounding.
  const aggregate =
    "About 40 percent of degrees are in engineering and technology fields, so the hands-on fit is strong.";
  const detail = "About 40 percent of degrees are in engineering and technology fields.";

  if (!validateRationale(aggregate, FIXTURE_COLLEGE, FIXTURE_PROFILE, [detail])) {
    failures.push("a grounded aggregate was rejected");
  }
  if (validateRationale(aggregate, FIXTURE_COLLEGE, FIXTURE_PROFILE)) {
    failures.push("an ungrounded aggregate was accepted");
  }

  return {
    passed: CASES.length + 4 - failures.length,
    failed: failures.length,
    failures,
  };
}
