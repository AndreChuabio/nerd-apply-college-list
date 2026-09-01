// POST /api/report
// Builds the college list for a student profile.
//
// The controlling design rule: matching is deterministic and Gemini is
// decoration. Scores, buckets, and score components come from data. The model
// only phrases the result, and every phrasing it returns must clear the
// guardrail before it is published. No Gemini outcome - outage, timeout,
// rate limit, malformed body, fabricated number - can fail this route or
// change which schools a student sees.

import { NextResponse } from "next/server";

import { getColleges } from "@/lib/colleges";
import {
  GeminiError,
  isGeminiConfigured,
  isRecord,
  normalizeProfile,
  writeRationales,
  type RationaleItem,
  type RationaleResult,
} from "@/lib/gemini";
import { validateRationale } from "@/lib/guardrail";
import { buildFallbackRationale, matchColleges } from "@/lib/match";
import type {
  ApiError,
  Bucket,
  Report,
  ReportResponse,
  ScoreComponent,
  ScoredCollege,
  StudentProfile,
} from "@/lib/types";

export const runtime = "nodejs";
// One batched Gemini call plus matching. The call itself aborts at 25s.
export const maxDuration = 60;

const MAX_SCHOOLS = 12;
const BASE_PER_BUCKET = 4;
// Unused slots go to targets first: they carry the most decision value.
const BUCKET_FILL_ORDER: readonly Bucket[] = ["target", "reach", "likely"];

// ---------- Story fit ----------
//
// Story fit is the one place a model influences the report's structure, and it
// is bounded on purpose. It reorders schools inside a bucket and nothing else:
// which bucket a school lands in, and how many schools each bucket holds, stay
// exactly where the deterministic matcher put them.
//
// The weight is the whole knob. At 3 points per story point, a perfect 10 is
// worth 30 - enough to lift a school past a mid-strength preference component,
// not enough to outrank a full program-fit match plus an in-state bonus. A
// student's narrative should move the order, not overwrite the data.
const STORY_FIT_WEIGHT = 3;
// Below this the signal is not worth a line in the report. Showing "Story fit
// +6" next to a lukewarm sentence adds noise to every card instead of marking
// the schools where the story genuinely lines up.
const STORY_FIT_VISIBLE_AT = 6;
const STORY_FIT_LABEL = "Story fit";

type BucketedColleges = Record<Bucket, ScoredCollege[]>;

function errorResponse(message: string, status: number): NextResponse<ApiError> {
  return NextResponse.json<ApiError>({ error: message }, { status });
}

/**
 * Trims the match output to a list a student will actually read.
 *
 * Takes an even slice from each bucket first, then redistributes leftover slots
 * so a thin bucket shortens itself rather than the whole report.
 */
function capBuckets(matched: BucketedColleges): BucketedColleges {
  const counts: Record<Bucket, number> = {
    reach: Math.min(BASE_PER_BUCKET, matched.reach.length),
    target: Math.min(BASE_PER_BUCKET, matched.target.length),
    likely: Math.min(BASE_PER_BUCKET, matched.likely.length),
  };

  let total = counts.reach + counts.target + counts.likely;
  let filledOne = true;

  while (total < MAX_SCHOOLS && filledOne) {
    filledOne = false;
    for (const bucket of BUCKET_FILL_ORDER) {
      if (total >= MAX_SCHOOLS) break;
      if (counts[bucket] >= matched[bucket].length) continue;
      counts[bucket] += 1;
      total += 1;
      filledOne = true;
    }
  }

  return {
    reach: matched.reach.slice(0, counts.reach),
    target: matched.target.slice(0, counts.target),
    likely: matched.likely.slice(0, counts.likely),
  };
}

/**
 * Requests rationales for the whole list in one batched call.
 *
 * Returns an empty array on any failure, including a missing key. Callers treat
 * a missing entry as "use the fallback", so an empty array degrades the report
 * to fully deterministic prose without failing the request.
 */
async function generateRationales(
  ordered: ScoredCollege[],
  profile: StudentProfile,
): Promise<RationaleResult[]> {
  if (ordered.length === 0 || !isGeminiConfigured()) return [];

  const items: RationaleItem[] = ordered.map((scored) => ({
    college: scored.college,
    bucket: scored.bucket,
    components: scored.components.map((component) => ({
      label: component.label,
      detail: component.detail,
    })),
  }));

  try {
    return await writeRationales(items, profile);
  } catch (error) {
    const reason =
      error instanceof GeminiError ? `${error.code}: ${error.message}` : String(error);
    console.warn(`[report] rationale generation degraded to fallback (${reason})`);
    return [];
  }
}

/**
 * Publishes model prose and the story-fit read only when the guardrail clears them.
 *
 * The two are judged independently against the same grounding data. A school
 * can keep a clean rationale and lose its story fit, or the reverse; a failure
 * on either side never drops the school itself.
 *
 * A short batch, an empty entry, or a fabricated number all land on the same
 * deterministic fallback, and the source is recorded so the difference is
 * visible in the report rather than hidden.
 */
function applyModelOutput(
  scored: ScoredCollege,
  profile: StudentProfile,
  candidate: RationaleResult | undefined,
): ScoredCollege {
  // The scorer's own detail strings are passed as grounding so a figure it
  // computed and showed the model is quotable, while anything else is not.
  const groundingDetails = scored.components.map((component) => component.detail);

  const rationale = candidate?.rationale ?? "";
  const withProse: ScoredCollege =
    rationale.length > 0 &&
    validateRationale(rationale, scored.college, profile, groundingDetails)
      ? { ...scored, rationale, rationaleSource: "gemini" }
      : {
          ...scored,
          rationale: buildFallbackRationale(scored, profile),
          rationaleSource: "fallback",
        };

  const reason = candidate?.storyFitReason ?? "";
  // Same digit check as the prose. A story-fit sentence is student-facing text
  // from the same call, so it earns no weaker a check just because it is short.
  if (
    reason.length === 0 ||
    !validateRationale(reason, scored.college, profile, groundingDetails)
  ) {
    return withProse;
  }

  const score = candidate?.storyFit ?? 0;
  const storyFit = { score, reason };

  if (score < STORY_FIT_VISIBLE_AT) {
    // Still attached, so the ordering and any downstream consumer can see it,
    // just not surfaced as its own line on the card.
    return { ...withProse, storyFit };
  }

  // Rendered by the existing components list in both the app and the PDF, so
  // this signal reaches the student with no change to either surface.
  const component: ScoreComponent = {
    label: STORY_FIT_LABEL,
    detail: reason,
    points: score * STORY_FIT_WEIGHT,
  };

  // The same points fold into the score so it stays the sum of the printed
  // components and matches the ordering key orderBucket sorts on.
  return {
    ...withProse,
    storyFit,
    score: withProse.score + component.points,
    components: [...withProse.components, component],
  };
}

/** Deterministic fit score plus the story-fit bonus. Used only for ordering. */
function orderingScore(scored: ScoredCollege): number {
  // A visible story fit is already folded into score as a component; adding it
  // again here would double-count it. Only a below-threshold story fit, which
  // has no component, still needs its bonus applied at ordering time.
  const folded = scored.components.some((component) => component.label === STORY_FIT_LABEL);
  if (folded) return scored.score;
  return scored.score + (scored.storyFit?.score ?? 0) * STORY_FIT_WEIGHT;
}

/**
 * Orders one bucket with story fit folded in.
 *
 * Tie-breaks mirror the matcher's own (graduation rate, then name), so with no
 * story fit anywhere in the list this reduces to the order the matcher already
 * produced. That is what makes the Gemini failure path byte-identical to the
 * behaviour before this layer existed.
 */
function orderBucket(schools: ScoredCollege[]): ScoredCollege[] {
  return [...schools].sort((a, b) => {
    const scoreDelta = orderingScore(b) - orderingScore(a);
    if (scoreDelta !== 0) return scoreDelta;

    const gradDelta = (b.college.gradRate ?? -1) - (a.college.gradRate ?? -1);
    if (gradDelta !== 0) return gradDelta;

    return a.college.name.localeCompare(b.college.name);
  });
}

export async function POST(request: Request): Promise<NextResponse<ReportResponse | ApiError>> {
  const startedAt = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  if (!isRecord(body) || !isRecord(body.profile)) {
    return errorResponse("A student profile is required", 400);
  }

  // The client can post anything. Re-narrow through the same rules the parse
  // step uses so a hand-edited profile cannot smuggle an out-of-range score
  // into the matcher.
  const profile = normalizeProfile(body.profile);

  let capped: BucketedColleges;
  try {
    capped = capBuckets(matchColleges(profile, getColleges()));
  } catch (error) {
    console.error("[report] matching failed", error);
    return errorResponse("Could not build a college list from that profile", 500);
  }

  const ordered: ScoredCollege[] = [...capped.reach, ...capped.target, ...capped.likely];
  const rationales = await generateRationales(ordered, profile);
  const decorated = ordered.map((scored, index) =>
    applyModelOutput(scored, profile, rationales[index]),
  );

  const reachEnd = capped.reach.length;
  const targetEnd = reachEnd + capped.target.length;

  // Re-ordering happens inside each bucket slice, never across them. Membership
  // and bucket sizes are the matcher's alone.
  const report: Report = {
    profile,
    generatedAt: new Date().toISOString(),
    reach: orderBucket(decorated.slice(0, reachEnd)),
    target: orderBucket(decorated.slice(reachEnd, targetEnd)),
    likely: orderBucket(decorated.slice(targetEnd)),
  };

  // Cost and quality signal for one report. At scale this is the line that
  // shows whether the guardrail is rejecting more prose than it should, and
  // whether story fit is landing or being dropped wholesale.
  const fromGemini = decorated.filter((scored) => scored.rationaleSource === "gemini").length;
  const scoredStories = decorated.filter((school) => school.storyFit !== undefined).length;
  const visibleStories = decorated.filter(
    (school) => (school.storyFit?.score ?? 0) >= STORY_FIT_VISIBLE_AT,
  ).length;
  console.info(
    `[report] schools=${decorated.length} gemini=${fromGemini} fallback=${
      decorated.length - fromGemini
    } storyfit=${scoredStories} storyfit_shown=${visibleStories} ms=${Date.now() - startedAt}`,
  );

  return NextResponse.json<ReportResponse>({ report });
}
