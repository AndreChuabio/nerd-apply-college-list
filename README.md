# College List Builder

A counselor pastes a free-form description of a student and gets back a Reach / Target / Likely college list with per-school reasoning, refined over versions, delivered as a print-quality PDF report the student keeps.

Nerd Apply's product is personalization at scale: the counselor's understanding of a student, turned into a document a family can act on, for hundreds of thousands of students at once. The bottleneck in that design is trust — a wrong admit rate or an invented "top 25 program" in a student's hands is real harm. So this build treats the LLM as a parser and a phrase-writer, never as a source of facts.

## Run it

Live: https://nerd-apply-takehome.vercel.app

Local:

```
npm install
cp .env.example .env.local   # add a free key from aistudio.google.com/apikey
npm run dev
```

Without a key the app still returns full lists using deterministic rationales; only parsing requires the key. Tests: `node --import tsx --test lib/match.test.ts`.

## Architecture

```
counselor text -> Gemini parse (structured output) -> typed StudentProfile
              -> deterministic matching vs 1,325 real colleges (College Scorecard snapshot)
              -> Reach / Target / Likely with labeled score components
              -> one batched Gemini call: grounded rationales + story-fit scores
              -> guardrail validates every sentence against the data
              -> interactive list, versioned refinements, client-side PDF report
```

## The matching engine (lib/match.ts — the part to judge)

The engine is deterministic and fully explainable. The LLM never selects a school, never moves a school between buckets, and never supplies a number.

**Bucketing — which band a school lands in.**

1. The student gets an academic index: SAT if stated, otherwise ACT converted through the official concordance table (interpolated between anchors), nudged +30 for a GPA above 3.7 and -30 below 3.0. The nudge is a labeled heuristic, visible in the component text.
2. That index is compared to the school's real middle-50 SAT window (SATVR25+SATMT25 to SATVR75+SATMT75, or the ACT window through the same concordance when SAT quartiles are missing). Below the 25th percentile: Reach. Inside: Target. Above the 75th: Likely.
3. Overrides, in order: an admit rate under 15 percent forces Reach no matter the scores; an admit rate under 30 percent can never be Likely (a 22-percent-admit school is not a safety for anyone — this rule exists because adversarial review caught exactly that case); a school with no test data at all is bucketed on admit-rate bands (under 0.25 / 0.25-0.60 / over 0.60) and its component says so plainly.
4. Students with no scores at all bucket on admit-rate bands, again labeled honestly.

**Fit scoring — which schools make the list and their order.** Every college in the snapshot is scored; the top four per bucket survive. Components, each with a human-readable, data-backed detail string that surfaces in the app and the PDF:

| Component | Weight | Source |
|---|---|---|
| Program fit | up to 40 | student interests mapped to CIP codes vs the school's actual share of degrees |
| Geography | +25 home state, +12 adjacent, -8 distant | US state adjacency map |
| Warm climate | +10 | hardcoded warm-state list (stated tradeoff) |
| Size preference | +10 | undergrad enrollment bands |
| Cost, when aid matters | up to +15 | average net price, banded |
| Hands-on orientation | small bonus | combined tech/engineering degree share, labeled as a proxy |

Ties break on graduation rate. A thin bucket borrows borderline schools from a neighbor, labeled as list balancing.

**Story fit — the semantic layer.** The batched rationale call also scores 0-10 how well each school serves what the deterministic components cannot see: the student's own narrative (an athlete ambition, a specific obsession, a family cost worry). It is instructed to score only that residual signal, may reorder schools within their bucket (weight x3), and may never assert anything about a school beyond the supplied data — an unverifiable thread comes back as the student's own item to check ("your interest in playing college soccer is worth verifying against its athletics offerings"), never as a school fact.

**The guardrail (lib/guardrail.ts).** Every model sentence — rationale and story-fit reason — is scanned for numbers. A number is allowed only if it traces to that school's data row, the student's profile, or a scaffolding context like "middle 50 percent"; fabricated values, including "top 25" style rankings, reject the sentence and swap in a deterministic fallback built from the score components. Rationales are paired to schools by an echoed index plus a cross-school name check, so a dropped entry in a model batch can never shift prose onto the wrong school. No Gemini failure of any kind blocks a report.

## Testing it

The three example prompts on the home page exercise different paths: John Smith (scores + near-home + hands-on), the marine-biology student (no scores, aid-sensitive, warm — buckets on admit-rate bands, list skews warm-state), and the soccer/finance student (strong story — watch the story-fit tags and the Babson rationale). Refine any list with new facts to get a v2 and a diff of what changed; mark a version final; reopen students from the home page.

## Decisions and tradeoffs

- No database: reports are JSON; browser storage covers the single-counselor MVP. MongoDB keyed by district is the real path.
- No outbound email infrastructure: the brief says the PDF is printed and hand-delivered. The email button prepares a draft in the counselor's own mail client; server-side sending belongs behind a district-verified domain.
- For-profit colleges excluded; warm climate is a state list, not climate data; distance is adjacency, not miles. All stated in-component where relevant.
- Model pinned to gemini-3.6-flash (new keys 404 on 2.5-flash), overridable via GEMINI_MODEL. Thinking turned down deliberately: rationale latency dropped 21s to 5s with no quality change.
- Bucket sizes are fixed at up to four; unused slots are not redistributed to other buckets — known, documented, judged too risky to change pre-submission.

## From 1 to 1,000,000 reports

Two model calls per report, roughly 4K input and 1.3K output tokens: about 0.8 cents per report at current flash pricing (0.75 and 3.75 dollars per million tokens), roughly 8,000 dollars per million reports before optimization. The path down: batch API for district-scale runs, context caching on the shared prompt prefix (0.15 per million cached input), and generating only the truly per-student prose — the matching engine is pure CPU and effectively free at any scale. The guardrail matters more at scale, not less: at a million reports, a one-in-ten-thousand fabrication rate is a hundred harmed students. District-level tenancy, report storage in S3, and a queue in front of the model calls are the first three pieces of real infrastructure this design asks for.

## With more time

Counselor-editable parsed profile before matching; real distance via lat/long; IPEDS athletics data so an athlete's thread becomes a scored component instead of a verify note; an eval set of counselor descriptions with expected bucket assertions in CI; district admin views.
