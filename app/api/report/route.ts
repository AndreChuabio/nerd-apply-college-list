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
} from "@/lib/gemini";
import { validateRationale } from "@/lib/guardrail";
import { buildFallbackRationale, matchColleges } from "@/lib/match";
import type {
  ApiError,
  Bucket,
  Report,
  ReportResponse,
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
): Promise<string[]> {
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
 * Publishes model prose only when the guardrail clears it.
 *
 * A short batch, an empty entry, or a fabricated number all land on the same
 * deterministic fallback, and the source is recorded so the difference is
 * visible in the report rather than hidden.
 */
function applyRationale(
  scored: ScoredCollege,
  profile: StudentProfile,
  candidate: string | undefined,
): ScoredCollege {
  // The scorer's own detail strings are passed as grounding so a figure it
  // computed and showed the model is quotable, while anything else is not.
  const groundingDetails = scored.components.map((component) => component.detail);

  if (
    typeof candidate === "string" &&
    candidate.trim().length > 0 &&
    validateRationale(candidate, scored.college, profile, groundingDetails)
  ) {
    return { ...scored, rationale: candidate.trim(), rationaleSource: "gemini" };
  }

  return {
    ...scored,
    rationale: buildFallbackRationale(scored, profile),
    rationaleSource: "fallback",
  };
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
    applyRationale(scored, profile, rationales[index]),
  );

  const reachEnd = capped.reach.length;
  const targetEnd = reachEnd + capped.target.length;

  const report: Report = {
    profile,
    generatedAt: new Date().toISOString(),
    reach: decorated.slice(0, reachEnd),
    target: decorated.slice(reachEnd, targetEnd),
    likely: decorated.slice(targetEnd),
  };

  // Cost and quality signal for one report. At scale this is the line that
  // shows whether the guardrail is rejecting more prose than it should.
  const fromGemini = decorated.filter((scored) => scored.rationaleSource === "gemini").length;
  console.info(
    `[report] schools=${decorated.length} gemini=${fromGemini} fallback=${
      decorated.length - fromGemini
    } ms=${Date.now() - startedAt}`,
  );

  return NextResponse.json<ReportResponse>({ report });
}
