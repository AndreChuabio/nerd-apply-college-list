// POST /api/parse
// Turns a counselor's freeform note about a student into a validated
// StudentProfile. This is the only place in the product where free text becomes
// structured data, which is what makes the rest of the pipeline deterministic.

import { NextResponse } from "next/server";

import { GeminiError, isGeminiConfigured, isRecord, parseProfile } from "@/lib/gemini";
import type { ApiError, ParseResponse } from "@/lib/types";

export const runtime = "nodejs";
// The parse step can spend two 20s Gemini attempts back to back (a first call
// plus one retry on unparseable JSON), so the budget matches the report route
// rather than cutting the retry off mid-flight.
export const maxDuration = 60;

const MAX_DESCRIPTION_LENGTH = 4000;

function errorResponse(message: string, status: number): NextResponse<ApiError> {
  return NextResponse.json<ApiError>({ error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse<ParseResponse | ApiError>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  const description = isRecord(body) ? body.description : undefined;

  if (typeof description !== "string" || description.trim().length === 0) {
    return errorResponse("A student description is required", 400);
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return errorResponse(
      `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
      400,
    );
  }

  // Checked before the call so a misconfigured deploy surfaces as a clear
  // message in the UI rather than a generic upstream failure.
  if (!isGeminiConfigured()) {
    return errorResponse("GEMINI_API_KEY not configured", 503);
  }

  try {
    const profile = await parseProfile(description);
    return NextResponse.json<ParseResponse>({ profile });
  } catch (error) {
    if (error instanceof GeminiError) {
      console.error(`[parse] gemini failure (${error.code}): ${error.message}`);

      if (error.code === "missing-api-key") {
        return errorResponse("GEMINI_API_KEY not configured", 503);
      }
      return errorResponse("Could not read that description. Try rewording it.", 502);
    }

    console.error("[parse] unexpected failure", error);
    return errorResponse("Unexpected error while parsing the description", 500);
  }
}
