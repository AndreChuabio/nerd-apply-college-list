# Nerd Apply Take-Home

Andre Chuabio's workspace for the Nerd Apply take-home technical. Received after 4pm ET 2026-09-01, 48-hour window, due about 4pm ET 2026-09-03. They expect roughly two hours of work. Goal: a working, well-reasoned solution shipped in about two focused hours, not a perfect one shipped late.

Address Andre as Senor Clown. Global rules in ~/.claude/CLAUDE.md still apply (ADHD response format, no emojis, no exclamation marks in code or docs, coding standards).

## The company and what they reward

- Nerd Apply: NYC edtech, personalized college-counseling reports for grades 7-12. Five people, 3.2M seed (Jan 2026, RiverPark Ventures). Founders Braden and Cooper Weissman. Charles Yang is Chief of Staff and runs this process.
- Product pivot, stated by Charles on the 2026-08-31 call: move from a counselor-facing platform to going direct to students through school districts and states, delivering hundreds of thousands to millions of personalized reports at scale. His exact line: "the bottleneck is people."
- What they hire for: leverage and automation at scale, generalist builders ("everyone's a builder"), "direction x speed = impact," 100x builders rather than task-executors. Bias every design decision toward scale and leverage, and say so in the writeup.
- AI-agent-first culture. Their own stack listing names Claude Code, Cursor, and Copilot. Building this with AI tooling is on-brand and expected. Build the way they build.

## Their stack (match it unless the prompt says otherwise)

TypeScript, React, Next.js, Node.js, Express, MongoDB, Elasticache, AWS S3, Vercel, Gemini.

Default choice when the prompt is open: Next.js with TypeScript, MongoDB if persistence is needed, Gemini or Anthropic if an LLM step is needed. Deploy to Vercel if a live URL adds credibility and takes under 10 minutes.

## How to win in two hours

1. Read the prompt twice. Restate the ask in one paragraph before writing code. Confirm the deliverable format (repo, zip, live URL, writeup) and any constraints on tools or libraries.
2. Ten-minute plan: name the smallest vertical slice that proves the core idea end to end. Build that slice first. Polish only after it runs.
3. Ship a running thing plus a short README: what was built, how to run it, key tradeoffs, what you would do with more time. The README is where scale thinking and engineering judgment show up. Keep it under one page.
4. Timebox hard. If a subproblem eats more than 20 minutes, cut scope and note it in the README as a conscious tradeoff. Honest scoping beats a half-finished ambitious build.
5. Test the happy path end to end before submitting. Fresh clone, install, run, confirm. A broken run instruction is the most common way a good take-home dies.

## Andre's edge to surface (only where it fits naturally)

- HelmIQ: founding engineer (not co-founder), production LLM pipelines, eval and cost harness, anti-fabrication safeguards. The multi-tenant data-isolation story: found a week-one cross-tenant leak, traced root cause, fixed it across the stack while the customer was live, then built guardrails. Maps directly to their "privacy and correctness are not optional" line. This story has NOT been told to them yet. The README or design notes are the place to spend it if the task touches data isolation, multi-tenancy, or correctness.
- rehab-as-code: personalized plans generated from de-identified data. Their own analogy on the listing is "like personalized treatment plans from de-identified data." Early build, test-data patients only. Never claim live patients.
- Verified stacks for every Andre project live in the projects-catalog memory. Never guess a stack or a fact about his work.

## Go-to subagents (launch independent ones in parallel, in one message)

- Plan before code: `Plan` or `ecc:code-architect` to turn the prompt into a build sequence with files and order.
- Build: `general-purpose` for straight implementation. `ai-eng-poc-to-prod` if the task has an LLM or Gemini step.
- Review before submit, all in parallel: `ecc:typescript-reviewer`, `ecc:react-reviewer`, `backend-reliability-guardian`. Add `ecc:database-reviewer` if there is a data layer.
- Unblock: `ecc:react-build-resolver` when a build or type error stalls progress.
- Library docs: `context7` for any Next.js, Mongo, Gemini, or Vercel API question. Do not answer from memory.

## Working rules

- Coding standards inherit from the global file. TypeScript: no `any`, explicit interfaces, handle null and undefined. Python if used: PEP8, docstrings, vectorized.
- Small commits with meaningful messages. Never credit Claude or any AI tool in commits, code, or comments. Never commit secrets; .env is gitignored.
- Honesty rule: the README describes only what actually runs. Never claim functionality that is stubbed or untested.
- Harness note: launch with `ECC_GATEGUARD=off claude` from this directory. That disables the ECC fact-forcing hook, which demands a written justification before every Bash command and every file write. In an empty greenfield repo its questions have no answers and it only costs a round trip per edit. Approve dev-command permissions with "always allow" as they appear; they persist for the project.
- IP boundary, non-negotiable: do NOT open, read, or copy from ~/HELMIQCRM or any other employer codebase during this take-home. HelmIQ is Jack's company with live paying clients. Every line submitted here is written fresh in this repo. If a HelmIQ detail is needed for the writeup, describe it from memory at the architecture level, never by pulling the source.

## Likely shape of the task (Charles telegraphed it on the 2026-08-31 call, see Granola transcript)

- His near-verbatim framing: "think about delivering hundreds of thousands to millions of reports, personalized and individual to each student, at scale. What do you think the bottlenecks are to that design, based literally on how this report looks and the information we want to put for each student such that it is personalized." Treat this as the problem space. Expect something about generating, structuring, or scaling personalized student reports.
- Attack angles that match his framing:
  1. Separate the report template from per-student data so personalization is data-driven, not hand-authored. Schema first.
  2. Any LLM step is the cost and throughput bottleneck. Batch, cache shared content, generate only the truly personal parts, and put a number on cost per report at 1M.
  3. Correctness at scale. A wrong claim in a student's report is a real harm. Validate structured inputs, constrain generation, and show one guardrail. This is where the HelmIQ anti-fabrication and eval-harness experience lands.
  4. Data model for millions of students across districts and states. Isolation by district is the HelmIQ multi-tenant story told in their domain.
  5. Show the path from 1 to 1M in the README even if the build handles 10. He said engineers who only think about the specific task will not succeed here.
- He tests product understanding. He opened with "what do you think our product is" and rated Andre's read "pretty good." Open the README with a one-paragraph read of their problem in their terms, then the build.
- He ships constantly ("I deployed three web apps today for the design team"). A live Vercel URL reads as fluency. Ship one if it takes under 10 minutes.
- The team is agent-heavy (he described people running dozens of agents each and probed how to coordinate that). Building this with agents is expected. Clean, reviewable, well-structured output matters more than proving it was typed by hand. Andre's answer on the call: the hard part is coordinating humans whose agents diverge, not running agents.
- Small-team ethos he stated: "what really needs to happen versus what does not, these tradeoffs are inherent." The README tradeoffs section is the direct answer to this.
- Do not contradict what Andre said on the call: strengths are flexible, fast, upfront, patient; growth areas are reading docs when AI stalls, coordinating 5+ people on one codebase, and customer exposure. He is willing to fully split from HelmIQ. Engineering team today is "one to two ish," so he would be the second engineer.
