// Gemini access layer. Server-only: this module reads GEMINI_API_KEY and must
// never be imported from a client component.
//
// Two calls exist in the whole product, and both are deliberately shaped for
// scale rather than convenience:
//   1. parseProfile   - one call per student intake, turning a counselor's note
//                       into a structured StudentProfile.
//   2. writeRationales - ONE call per report covering every school on the list.
//                       Per-school calls would multiply cost and latency by the
//                       length of the list for no quality gain.
//
// Every model response is treated as untrusted input. Structured output narrows
// the shape; the hand-written validators below narrow the values.

import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";
import type {
  College,
  LearningStyle,
  ProgramArea,
  SizePreference,
  StudentProfile,
} from "@/lib/types";

// ---------- Configuration ----------

// Pinned model id, overridable per environment so the pin can move without a
// code change. Report generation should never float across model versions on
// its own: a silent model swap changes prose quality and cost with no diff to
// review. Note that gemini-2.5-flash is listed by the models endpoint but
// returns 404 on generateContent for keys issued after its cutoff, so the
// default is the current flash generation.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

const PARSE_TIMEOUT_MS = 20_000;
const RATIONALE_TIMEOUT_MS = 25_000;

// Caps that keep a hostile or runaway input from turning into an unbounded prompt.
const MAX_INTERESTS = 5;
const MAX_HIGHLIGHTS = 6;
const MAX_HIGHLIGHT_LENGTH = 240;

// Story fit is a 0-10 integer. The bounds live here because both the schema
// description and the clamp have to agree on them.
const MIN_STORY_FIT = 0;
const MAX_STORY_FIT = 10;
const MAX_STORY_FIT_REASON_LENGTH = 240;

// ---------- Typed errors ----------

export type GeminiErrorCode =
  | "missing-api-key"
  | "upstream"
  | "empty-response"
  | "unparseable-json";

/** Error type every failure in this module resolves to, so callers can branch on `code`. */
export class GeminiError extends Error {
  readonly code: GeminiErrorCode;

  constructor(code: GeminiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeminiError";
    this.code = code;
  }
}

/** True when a key is present. Callers use this to skip the model entirely rather than fail. */
export function isGeminiConfigured(): boolean {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
}

// ---------- Enum vocabularies ----------

const PROGRAM_AREAS: readonly ProgramArea[] = [
  "computer-science",
  "engineering",
  "biology",
  "marine-biology",
  "natural-resources",
  "business",
  "health",
  "psychology",
  "visual-performing-arts",
  "mathematics",
  "physical-sciences",
  "social-sciences",
  "english",
  "history",
  "education",
  "communications",
  "undecided",
];

const SIZE_PREFERENCES: readonly SizePreference[] = ["small", "medium", "large"];
const LEARNING_STYLES: readonly LearningStyle[] = ["hands-on", "research", "balanced"];

// Gemini handles a nullable enum far less reliably than an enum with an explicit
// "not stated" member, so the schema offers a sentinel and the validator maps it
// back to null.
const UNSTATED = "unknown";

const PROGRAM_AREA_SET = new Set<string>(PROGRAM_AREAS);
const SIZE_PREFERENCE_SET = new Set<string>(SIZE_PREFERENCES);
const LEARNING_STYLE_SET = new Set<string>(LEARNING_STYLES);

// ---------- Shared request helper ----------

interface GenerateJsonRequest {
  systemInstruction: string;
  prompt: string;
  schema: Schema;
  timeoutMs: number;
  temperature: number;
  thinkingLevel: ThinkingLevel;
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("missing-api-key", "GEMINI_API_KEY not configured");
  }
  return new GoogleGenAI({ apiKey });
}

/** Renders an unknown thrown value as a string with the API key scrubbed out. */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const apiKey = process.env.GEMINI_API_KEY;
  return apiKey ? raw.split(apiKey).join("[redacted]") : raw;
}

/**
 * Issues a single structured-output request and returns the parsed JSON.
 *
 * Retries exactly once, and only when the transport succeeded but the body did
 * not parse. Transport failures (timeout, 5xx, rate limit) throw immediately:
 * the callers of this module all have a deterministic fallback, so burning a
 * second 25-second timeout would hurt the user more than it helps.
 */
async function generateJson(request: GenerateJsonRequest): Promise<unknown> {
  const ai = getClient();
  let lastFailure = "no attempt completed";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? request.prompt
        : `${request.prompt}\n\nThe previous response could not be parsed as JSON. Respond with JSON matching the schema and nothing else.`;

    let text: string | undefined;
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          systemInstruction: request.systemInstruction,
          responseMimeType: "application/json",
          responseSchema: request.schema,
          temperature: request.temperature,
          // Both tasks are grounded transforms over facts already supplied, so
          // extended reasoning buys nothing and costs seconds and tokens. On
          // the batched rationale call this is the difference between finishing
          // inside the abort window and losing the whole batch to fallback.
          thinkingConfig: { thinkingLevel: request.thinkingLevel },
          // A fresh signal per attempt; a reused expired signal aborts instantly.
          abortSignal: AbortSignal.timeout(request.timeoutMs),
        },
      });
      text = response.text;
    } catch (error) {
      throw new GeminiError("upstream", `Gemini request failed: ${describeError(error)}`, {
        cause: error,
      });
    }

    if (!text || text.trim().length === 0) {
      lastFailure = "model returned an empty response";
      continue;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      lastFailure = describeError(error);
    }
  }

  throw new GeminiError(
    "unparseable-json",
    `Gemini returned unusable JSON after a retry: ${lastFailure}`,
  );
}

// ---------- Narrowing validators ----------
//
// Structured output constrains the shape but not the semantics: the model can
// still return a 6.2 GPA, an SAT of 1237, or a state code of "Pennsylvania".
// Everything below is hand-written on purpose so the exact clamp rules are
// visible and testable rather than buried in a schema library.

/** Narrows unknown JSON to a plain object. Shared with the routes so body parsing has one rule. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === UNSTATED) return null;
  return trimmed.slice(0, 120);
}

/** GPA on a 0-5 scale. Non-positive is read as "not stated" rather than a real zero. */
function normalizeGpa(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return Math.round(Math.min(parsed, 5) * 100) / 100;
}

/** SAT total clamped to the real 400-1600 scale and rounded to the reported 10-point grain. */
function normalizeSat(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  const rounded = Math.round(parsed / 10) * 10;
  return Math.min(Math.max(rounded, 400), 1600);
}

/** ACT composite clamped to the real 1-36 scale. */
function normalizeAct(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return Math.min(Math.max(Math.round(parsed), 1), 36);
}

/** USPS two-letter code, uppercased. Anything else becomes null rather than a guess. */
function normalizeState(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>): T | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return allowed.has(candidate) ? (candidate as T) : null;
}

/** Keeps only recognized program areas, de-duplicated and capped. */
function normalizeInterests(value: unknown): ProgramArea[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ProgramArea[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const candidate = entry.trim().toLowerCase();
    if (!PROGRAM_AREA_SET.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate as ProgramArea);
    if (result.length >= MAX_INTERESTS) break;
  }
  return result;
}

function normalizeHighlights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    result.push(trimmed.slice(0, MAX_HIGHLIGHT_LENGTH));
    if (result.length >= MAX_HIGHLIGHTS) break;
  }
  return result;
}

/**
 * Narrows arbitrary untrusted input into a StudentProfile.
 *
 * Used on the model's parse output and again on the profile a client POSTs to
 * the report route, so both paths converge on one set of rules.
 */
export function normalizeProfile(raw: unknown): StudentProfile {
  const source: Record<string, unknown> = isRecord(raw) ? raw : {};
  return {
    name: normalizeName(source.name),
    gpa: normalizeGpa(source.gpa),
    satTotal: normalizeSat(source.satTotal),
    actComposite: normalizeAct(source.actComposite),
    interests: normalizeInterests(source.interests),
    homeState: normalizeState(source.homeState),
    prefersNearHome: normalizeBoolean(source.prefersNearHome),
    prefersWarmClimate: normalizeBoolean(source.prefersWarmClimate),
    sizePreference: normalizeEnum<SizePreference>(source.sizePreference, SIZE_PREFERENCE_SET),
    learningStyle: normalizeEnum<LearningStyle>(source.learningStyle, LEARNING_STYLE_SET),
    needsFinancialAid: normalizeBoolean(source.needsFinancialAid),
    narrativeHighlights: normalizeHighlights(source.narrativeHighlights),
  };
}

// ---------- Step 1: parse a counselor note into a profile ----------

const PROFILE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      nullable: true,
      description: "The student's name exactly as written. Null if the note does not name them.",
    },
    gpa: {
      type: Type.NUMBER,
      nullable: true,
      description: "GPA on a 4.0 scale. Null if no GPA is stated. Never estimate one.",
    },
    satTotal: {
      type: Type.INTEGER,
      nullable: true,
      description: "Total SAT score, 400 to 1600. Null if no SAT score is stated.",
    },
    actComposite: {
      type: Type.INTEGER,
      nullable: true,
      description: "ACT composite, 1 to 36. Null if no ACT score is stated.",
    },
    interests: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: [...PROGRAM_AREAS] },
      description:
        "Academic areas the note points to, most relevant first. Empty array if nothing is indicated. Use undecided only when the note says the student is undecided.",
    },
    homeState: {
      type: Type.STRING,
      nullable: true,
      description:
        "USPS two-letter code for the student's home state, for example PA. Null if the note does not indicate a home state.",
    },
    prefersNearHome: {
      type: Type.BOOLEAN,
      description: "True only if the note says the student wants to stay close to home.",
    },
    prefersWarmClimate: {
      type: Type.BOOLEAN,
      description: "True only if the note mentions wanting warm weather or a warm climate.",
    },
    sizePreference: {
      type: Type.STRING,
      enum: [...SIZE_PREFERENCES, UNSTATED],
      description: "Preferred campus size. Use unknown when the note does not say.",
    },
    learningStyle: {
      type: Type.STRING,
      enum: [...LEARNING_STYLES, UNSTATED],
      description:
        "hands-on for practical or applied learning, research for academic or theory-driven, balanced for both. Use unknown when the note does not say.",
    },
    needsFinancialAid: {
      type: Type.BOOLEAN,
      description: "True only if the note mentions cost, affordability, aid, or scholarships.",
    },
    narrativeHighlights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Short phrases capturing awards, activities, and story hooks stated in the note, for example 'won the Congressional App Challenge for Pennsylvania'. Quote the note's own facts. Empty array if there are none.",
    },
  },
  required: [
    "name",
    "gpa",
    "satTotal",
    "actComposite",
    "interests",
    "homeState",
    "prefersNearHome",
    "prefersWarmClimate",
    "sizePreference",
    "learningStyle",
    "needsFinancialAid",
    "narrativeHighlights",
  ],
  propertyOrdering: [
    "name",
    "gpa",
    "satTotal",
    "actComposite",
    "interests",
    "homeState",
    "prefersNearHome",
    "prefersWarmClimate",
    "sizePreference",
    "learningStyle",
    "needsFinancialAid",
    "narrativeHighlights",
  ],
};

const PARSE_SYSTEM_INSTRUCTION = [
  "You extract structured facts from a school counselor's freeform note about a student.",
  "Record only what the note states or clearly implies.",
  "Never invent a GPA, a test score, or a home state. When a field is not stated, return null or the unknown option.",
  "Inferring a home state from a state named in an award is acceptable; inferring one from a school name is not.",
].join(" ");

/**
 * Turns a freeform counselor description into a validated StudentProfile.
 *
 * @param description Freeform text about the student.
 * @throws {GeminiError} When the key is missing, the request fails, or the body never parses.
 */
export async function parseProfile(description: string): Promise<StudentProfile> {
  const raw = await generateJson({
    systemInstruction: PARSE_SYSTEM_INSTRUCTION,
    prompt: [
      "Extract the student profile from the note below.",
      "",
      "NOTE:",
      '"""',
      description.trim(),
      '"""',
    ].join("\n"),
    schema: PROFILE_SCHEMA,
    // Extraction is a deterministic task; creativity here shows up as fabrication.
    temperature: 0,
    thinkingLevel: ThinkingLevel.MINIMAL,
    timeoutMs: PARSE_TIMEOUT_MS,
  });

  return normalizeProfile(raw);
}

// ---------- Step 2: batched rationales for a whole list ----------

/** One school's worth of grounding material for the rationale pass. */
export interface RationaleItem {
  college: College;
  bucket: string;
  components: { label: string; detail: string }[];
}

/** One school's worth of model output: the prose plus the scored story-fit read. */
export interface RationaleResult {
  rationale: string;
  /** Integer 0-10. Zero whenever the entry carried no usable reason. */
  storyFit: number;
  /** One sentence. Empty means the caller must not publish a story fit for this school. */
  storyFitReason: string;
}

const RATIONALES_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      rationale: {
        type: Type.STRING,
        description: "A two-sentence rationale for the school at the matching index.",
      },
      storyFit: {
        type: Type.INTEGER,
        description:
          "Integer 0 to 10 for how well this school serves the parts of the student's story that whyItScored does not already credit. 0 to 3 when nothing in the block speaks to their own words beyond that credit, 4 to 6 when one distinctive thread is served, 7 to 10 when several are.",
      },
      storyFitReason: {
        type: Type.STRING,
        description:
          "Exactly one sentence, addressed to the student, naming the thread of their own narrative this score is about. Never a restatement of a whyItScored entry.",
      },
    },
    required: ["rationale", "storyFit", "storyFitReason"],
    propertyOrdering: ["rationale", "storyFit", "storyFitReason"],
  },
};

const RATIONALE_SYSTEM_INSTRUCTION = [
  "You write short rationales for a college counselor's student-facing college list, and you score how well each school serves the student's own story.",
  "For each school, use only the facts inside that school's JSON block plus the student profile.",
  "Never introduce a number, statistic, ranking, program, or claim that is not in the provided data.",
  "The rationale is exactly two sentences. Warm and professional, addressed to the student.",
  "No emojis. No exclamation marks. No hedging filler such as 'it seems' or 'perhaps'.",
  // The story-fit rules are the whole safety surface of this field: it invites
  // the model to reason about things the dataset does not cover (athletics,
  // campus culture, specific majors), which is exactly where a report starts
  // making promises a school never made.
  "The story fit score judges only how well THIS school, as described in its block, serves THIS student's story as they told it.",
  // Without this the score silently becomes a second copy of the deterministic
  // scorer: the model reads whyItScored, agrees with it, and awards a high
  // story fit for restating the components already printed on the same card.
  // Story fit only earns its place by covering what the scorer cannot see.
  "The whyItScored entries already credit the student's stated interests, location, campus size, cost, and learning style. Story fit must never re-credit them.",
  "Story fit is about what those entries cannot see: the student's own words, activities, ambitions, and worries, especially their narrativeHighlights.",
  "If the only connection you can name is one whyItScored already lists, the score is low, not high. A reason that restates a whyItScored entry is wrong.",
  // The line between "re-crediting" and "reading the student properly". A
  // parsed interest of 'business' loses the fact that this student is obsessed
  // with finance specifically; a school whose block answers that intensity is
  // serving the story, not repeating the component.
  "Where the student's own words are more specific or more intense than that generic credit, a block that answers the specific version does earn story fit. Judging that is the point of this field.",
  "Score the strength of the connection, not your confidence. If your sentence says a school aligns strongly with their story, the number must say so too.",
  "Use the full range and discriminate between schools. Giving every school on a list the same score means the signal is not being judged.",
  "The reason must never assert a fact about the school that is not in its block. No athletics claims, no campus culture claims, no program claims beyond the degree shares given.",
  "When the student's story raises something the block cannot speak to, write it as their own thread to verify, not as a fact about the school. For example: 'Your interest in playing college soccer is worth checking against its athletics offerings.'",
  "Score the story, not your own knowledge of the school. A school you happen to know is famous for something scores no higher for it unless the block says so.",
].join(" ");

/** Rounds a 0-1 rate into whole percent, or null when the rate is missing. */
function toPercent(rate: number | null): number | null {
  return rate === null || !Number.isFinite(rate) ? null : Math.round(rate * 100);
}

/** Sums an SAT section pair, or null when either half is missing. */
function sumSat(reading: number | null, math: number | null): number | null {
  return reading === null || math === null ? null : reading + math;
}

/**
 * Builds the per-school fact block.
 *
 * Every number emitted here is one the guardrail's allowed set can account for.
 * Adding a derived figure to this block without adding it to the allowed set
 * would make the guardrail reject its own grounding data.
 */
function buildCollegeBlock(item: RationaleItem, index: number): Record<string, unknown> {
  const { college } = item;
  return {
    index,
    bucket: item.bucket,
    name: college.name,
    city: college.city,
    state: college.state,
    control: college.control,
    admitRatePercent: toPercent(college.admitRate),
    satMiddle50Low: sumSat(college.satReading25, college.satMath25),
    satMiddle50High: sumSat(college.satReading75, college.satMath75),
    satAverage: college.satAvg,
    actMiddle50Low: college.actComposite25,
    actMiddle50High: college.actComposite75,
    undergradSize: college.undergradSize,
    averageNetPrice: college.avgNetPrice,
    tuitionInState: college.tuitionInState,
    tuitionOutOfState: college.tuitionOutOfState,
    fourYearGradRatePercent: toPercent(college.gradRate),
    medianEarnings10Year: college.medianEarnings10yr,
    whyItScored: item.components.map((component) => `${component.label}: ${component.detail}`),
  };
}

function buildProfileBlock(profile: StudentProfile): Record<string, unknown> {
  return {
    name: profile.name,
    gpa: profile.gpa,
    satTotal: profile.satTotal,
    actComposite: profile.actComposite,
    interests: profile.interests,
    homeState: profile.homeState,
    prefersNearHome: profile.prefersNearHome,
    prefersWarmClimate: profile.prefersWarmClimate,
    sizePreference: profile.sizePreference,
    learningStyle: profile.learningStyle,
    needsFinancialAid: profile.needsFinancialAid,
    narrativeHighlights: profile.narrativeHighlights,
  };
}

/** Clamps the model's story-fit number to the documented 0-10 integer scale. */
function normalizeStoryFit(value: unknown): number {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return MIN_STORY_FIT;
  return Math.min(Math.max(Math.round(parsed), MIN_STORY_FIT), MAX_STORY_FIT);
}

/**
 * Narrows one entry of the batch.
 *
 * A score without a reason is dropped to zero rather than published bare: a
 * number a student cannot see the argument for is worse than no number, and
 * the caller keys "publish a story fit at all" off a non-empty reason.
 */
function normalizeRationaleEntry(entry: unknown): RationaleResult {
  if (!isRecord(entry)) {
    return { rationale: "", storyFit: MIN_STORY_FIT, storyFitReason: "" };
  }

  const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
  const reason =
    typeof entry.storyFitReason === "string"
      ? entry.storyFitReason.trim().slice(0, MAX_STORY_FIT_REASON_LENGTH)
      : "";

  if (reason.length === 0) {
    return { rationale, storyFit: MIN_STORY_FIT, storyFitReason: "" };
  }

  return { rationale, storyFit: normalizeStoryFit(entry.storyFit), storyFitReason: reason };
}

/**
 * Writes one rationale and one story-fit read per school in a single batched request.
 *
 * Deliberately still ONE call for the whole list. Story fit is extra fields on
 * the same response, not a second pass: a per-school or per-signal call would
 * multiply cost and latency by the length of the list for no quality gain.
 *
 * Returns an array positionally aligned with `items`. Entries may carry empty
 * strings and the array may be shorter than `items`; the caller is expected to
 * fall back per school rather than trust the length.
 *
 * @throws {GeminiError} On a missing key, a transport failure, a 25s timeout, or unusable JSON.
 */
export async function writeRationales(
  items: RationaleItem[],
  profile: StudentProfile,
): Promise<RationaleResult[]> {
  if (items.length === 0) return [];

  const schools = items.map((item, index) => buildCollegeBlock(item, index));

  const prompt = [
    `Write one rationale and one story fit read for each of the ${items.length} schools below.`,
    "",
    "STUDENT PROFILE:",
    JSON.stringify(buildProfileBlock(profile), null, 2),
    "",
    "SCHOOLS:",
    JSON.stringify(schools, null, 2),
    "",
    `Return a JSON array of exactly ${items.length} objects, in the same order as the SCHOOLS array.`,
    "The object at each position describes the school at that index.",
    "",
    "rationale: two sentences. Ground every sentence in that school's own block. A number that does not appear in the block must not appear in the rationale.",
    "",
    "storyFit: an integer 0 to 10 for how well this school serves the parts of the student's story that this school's whyItScored entries do NOT already credit.",
    "  whyItScored already covers their stated interests, location, size, cost, and learning style. Re-crediting any of those is wrong.",
    "  Judge what it cannot cover: their own words, activities, ambitions, and worries, above all their narrativeHighlights.",
    "  Where their own words are more specific or more intense than that generic credit, a block that answers the specific version does earn story fit.",
    "  Keep the number and the sentence consistent. A sentence saying a school aligns strongly must carry a high number.",
    "  0 to 3: nothing in this block speaks to their own words beyond what whyItScored already credits.",
    "  4 to 6: this block speaks to one distinctive thread of their narrative more specifically than that credit does.",
    "  7 to 10: this block speaks to several distinct threads of their narrative, or to one with unusual strength.",
    "  Discriminate between these schools. If every school gets the same score, you are not judging the signal.",
    "",
    "storyFitReason: one sentence, addressed to the student, naming the thread the score is about. Never a restatement of a whyItScored entry.",
    "  It must not assert anything about the school beyond this block. No athletics, no campus culture, no programs beyond the degree shares given.",
    "  If their story raises something the block cannot speak to, phrase it as theirs to verify, for example 'Your interest in playing college soccer is worth checking against its athletics offerings'.",
    "  The same numeric rule as the rationale applies: a number not in the block must not appear.",
  ].join("\n");

  const raw = await generateJson({
    systemInstruction: RATIONALE_SYSTEM_INSTRUCTION,
    prompt,
    schema: RATIONALES_SCHEMA,
    // Low temperature keeps story-fit scores stable across runs while the
    // prose stays anchored to the supplied facts.
    temperature: 0.2,
    thinkingLevel: ThinkingLevel.LOW,
    timeoutMs: RATIONALE_TIMEOUT_MS,
  });

  if (!Array.isArray(raw)) {
    throw new GeminiError("unparseable-json", "Expected a JSON array of rationale objects");
  }

  return raw.map(normalizeRationaleEntry);
}
