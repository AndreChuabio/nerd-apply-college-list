# College List Builder

A counselor pastes a free-form description of a student and gets back a Reach / Target / Likely college list, refined over versions, delivered as a print-quality PDF report the student keeps. Live URL below; runs locally in two minutes.

Nerd Apply's product is personalization at scale: the counselor's understanding of a student, turned into a document a family can act on, for hundreds of thousands of students at once. The bottleneck in that design is never the prose, it is trust — a wrong admit rate or invented SAT range in a student's hands is real harm. So this build treats the LLM as a parser and a phrase-writer, never as a source of facts.

## How it works

```
counselor text -> Gemini parse (structured output) -> typed StudentProfile
              -> deterministic matching vs 1,325 real colleges (College Scorecard snapshot)
              -> Reach / Target / Likely with labeled, explainable score components
              -> one batched Gemini call writes per-school rationales, constrained to supplied facts
              -> digit guardrail rejects any sentence with a number not in the data
              -> client-side 2-page PDF report
```

- Bucketing compares the student's academic index (SAT, or ACT via concordance, GPA-nudged) against each school's real middle-50 range. Admit rate under 15 percent forces Reach. Missing data falls back to admit-rate bands, labeled honestly.
- Fit scoring orders schools: program strength from actual degree-share data, home-state adjacency, climate, size, net price when aid matters. Every component ships a human-readable reason that appears in the app and the PDF.
- Rationales that fail the guardrail, or any Gemini outage, degrade to deterministic prose built from score components. No model failure can block or corrupt a report.
- Counselor workflow: refine any list with added context to produce v2, v3; mark the final version; recent students persist in the browser (localStorage, no accounts for the MVP).

## Run it

Live: https://nerd-apply-takehome.vercel.app

Local:

```
npm install
cp .env.example .env.local   # add a free key from aistudio.google.com/apikey
npm run dev
```

Without a key the app still returns full lists using deterministic rationales; parsing requires the key. Tests: `node --import tsx --test lib/match.test.ts`. Dataset refresh: `npx tsx scripts/build-dataset.ts` (source URL in the script header).

## Decisions and tradeoffs

- No database. The deliverable is a working product, not infrastructure. Reports are JSON; browser storage covers the single-counselor MVP. The real system wants MongoDB for students and versions, keyed by district for isolation.
- No email sending. The brief says the PDF is printed and hand-delivered. An email step is an obvious v2, not MVP scope.
- For-profit colleges excluded from the dataset — a counselor-product judgment call.
- Warm-climate preference is a hardcoded state list, not climate data. Cheap and transparent; swap for NOAA data later.
- Model pinned to gemini-3.6-flash (new keys 404 on 2.5-flash), thinking turned down deliberately: rationale latency dropped from 21s to 5s with no quality change, and thinking tokens bill as output.

## From 1 to 1,000,000 reports

The pipeline is two model calls per report, roughly 4K input and 1.3K output tokens. At current flash pricing (0.75 and 3.75 dollars per million tokens) that is about 0.8 cents per report, roughly 8,000 dollars per million reports before optimization. The path down: batch API for asynchronous district-scale runs, context caching on the shared system prompt and instructions (0.15 per million cached input), and generating only the truly per-student prose — the matching engine is pure CPU and effectively free at any scale. The guardrail matters more at scale, not less: at a million reports, a one-in-ten-thousand fabrication rate is a hundred harmed students, which is why numbers render from data and prose is validated against it. District-level tenancy, report storage in S3, and a queue in front of the model calls are the first three pieces of real infrastructure this design asks for.

## With more time

Counselor-editable parsed profile before matching; real distance via lat/long instead of state adjacency; an eval set of counselor descriptions with expected bucket assertions running in CI; district admin views over stored reports.
