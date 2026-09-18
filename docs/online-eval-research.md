# Online eval: what the market does, and where openevals sits

Research notes, 2026-09-18. Sources are linked at the end; Langfuse API facts were read directly from the API definition files in the Langfuse repository.

## Three modes of online evaluation

| mode | latency | failure tolerance | who does it |
|---|---|---|---|
| Inline guardrail | < 500 ms, in the request | must fail open | Galileo Luna-2 (~150 ms), Patronus runtime guardrails, safety classifiers (Llama Guard, ShieldGemma, OpenAI moderation) |
| Async post-hoc | seconds to minutes after the trace lands | zero impact on the app | Braintrust (trace idle 30 s), LangSmith, Opik, Datadog, Weave, Confident AI, Langfuse |
| Sampled drift | hours to days, 1–10% | none | everyone, as the cost lever |

openevals is an async post-hoc grader by default (the Langfuse connector) with a direct-ingestion fast lane for early-stop signals. It is not a safety guardrail: jev is documented as not adversarially robust.

## What every platform already has

Rules on incoming traces, a sampling rate, filters, span / trace / session granularity, the customer's own LLM key as the judge, scores attached to the trace, some form of human annotation. These are table stakes, not differentiators.

What is rare:

- **Full coverage.** At $0.01–0.10 per judge call, 100k requests/day at 100% is ~$30k/month per metric, so vendors recommend 1–10% sampling. Only Galileo (Luna-2, Enterprise tier) and Patronus (Lynx/Glider) ship small purpose-built judges that make full coverage affordable.
- **Per-step grading with context.** Langfuse's observation-level evaluators can only read the matched observation's own input/output/metadata/tool calls, not sibling steps.
- **Judge calibration.** LangSmith's Tuned Evaluators (beta) and a Galileo blog post are the only direct treatments. Practitioner consensus: 50–300 labeled traces, ≥80% agreement or κ > 0.6 before a judge gates anything.
- **Judge determinism.** Recognised production risk; mitigations are binary questions over numeric scales, ensembles, and re-calibration over time. jev's typed questions and a published probability std-dev of 0.0102 across repeats address this structurally.

## Langfuse specifics that shaped the connector

- `GET /api/public/v2/observations` is "the only real-time read path"; other endpoints can lag ~10 minutes. `fromStartTime` is required, pagination is cursor-based, `limit` max 1000, `fields` groups select `io`, `metadata`, `model`, `usage`, `trace_context` (traceName, tags, release). Input/output come back as raw strings.
- v1 traces/observations/sessions and v1/v2 scores endpoints are deprecated; Langfuse Cloud serves them until **2026-11-16**. Scores are read from `GET /api/public/v3/scores` (filters: `source`, `queueId`, `authorUserId`, `traceId`, …).
- `POST /api/public/scores` and the ingestion `score-create` event accept `traceId`, `observationId`, `name`, `value`, `dataType`, `comment`, **`metadata`**, `environment`, `configId`, `queueId`, and an idempotency `id`. `source` may be `API` or `ANNOTATION`; **`EVAL` is reserved** for Langfuse's own evaluators. Writing `ANNOTATION` requires a `configId`.
- No trace or score webhooks (only prompt-version events); blob export runs at most every 20 minutes and is gated to Pro (add-on) / Enterprise. External pipelines poll.
- Langfuse's own evaluators are `llm_as_judge` or `code` (Python / TypeScript). Code evaluators run **without network egress**, within 2 seconds, standard library only, so a jev-backed grader cannot run inside Langfuse. Evaluators and rules have a public API (`/api/public/v2/evaluators`, `/api/public/v2/evaluation-rules`) with a 0–1 `sampling` fraction.
- A self-hosted user reported a 2-hour evaluation delay under load (106k jobs queued); the fix was worker concurrency. Langfuse does not meter the cost or latency of its judge calls.
- Since June 2025 evals, annotation queues and datasets are in the MIT core; all cloud plans include LLM-as-a-judge. Only annotation-queue count (1 / 3 / unlimited) and blob export are gated.

## jev as an online judge

| | value | note |
|---|---|---|
| price | $0.042 / M input tokens | output free; no minimum, no enterprise pricing page |
| rate | 1,200 requests/min · 250k tokens/s | "dynamically adjusting"; no separate concurrency figure |
| budget | 64k tokens/request, state + longest question ≤ 32k | ~150k English characters |
| latency | 13 questions / 54k chars → 0.27 s | the only published number; no p50/p99, no SLA |
| consistency | probability std-dev 0.0102 over 15 repeats | better than temperature-0 Haiku / GPT-mini; individual answers can still cross 0.5 |
| versioning | `jev-1.13.0`; aliases move silently | pin the numeric version |
| languages | undocumented | all examples English |
| deployment | API only | no regions, VPC or on-prem; ZDR for enterprise |

Documented weaknesses (jaggedness): literal interpretation, weak counting and numeric comparison, dates as text, multi-hop reasoning and double negatives degrade, large irrelevant content hurts, steerable by injected instructions, P(yes)+P(no) need not sum to 1. Scope jev to narrow, single-hop, non-adversarial judgments.

## Cost at 100k traces/day, 20 steps each

| | per day |
|---|---|
| frontier judge, every step, 100% | ~$20,000 |
| frontier judge, trace-level only, 10% sample (the common practice) | ~$100 |
| jev, every step + trace-level, 100% | ~$189 |
| jev, trace-level only, 100% | ~$21 |

Assumptions: 5k tokens per trace-level state, 2k per step state, $0.01 per frontier call. jev at full per-step coverage costs about what others pay to sample 10% of outcomes. The same volume is ~1,450 jev requests/min, above the published 1,200/min: hence the process-wide limiter (`OPENEVALS_JEV_RPM`), per-step sampling for very long runs (`OPENEVALS_STEP_MAX`), and the daily budget (`OPENEVALS_DAILY_BUDGET_USD`).

## Positioning

*Langfuse grades a sample of your traces with your GPT key. openevals grades every step of every trace with jev, writes the scores back, and tells you which of your metrics to trust.*

Cut: our own trace store as a product surface, the trace list as home, the in-app pass/fail button (annotate in Langfuse). Keep as fast lane: direct ingestion and the SDK, for early-stop. Out of scope: safety guardrails, dataset management.

## Open questions

- Langfuse deployment (cloud vs self-hosted, version): v2 observations and score `metadata` availability; rate limits.
- Whether score `metadata` is visible in the Langfuse score UI or only via API.
- jev accuracy on non-English trajectories for the four per-step questions: needs 50–100 human-labeled traces and a backtest.
- Whether TypeSafe raises the request limit per customer, and any p99 data.

## Sources

- Langfuse API definitions: github.com/langfuse/langfuse, `fern/apis/server/definition/{scores,scores-v3,evaluators,evaluation-rules,evaluation-commons,observations,ingestion,annotation-queues,commons}.yml`
- langfuse.com/docs: evaluation-methods/llm-as-a-judge, evaluation-methods/code-evaluators, core-concepts, faq/all/deprecated-api-migration, api-and-data-platform/features/export-to-blob-storage, pricing, blog/2025-06-04-open-sourcing-langfuse-product; GitHub discussions 1033 (webhooks), 10773 (eval delay)
- LangSmith rules / online-evaluations; Braintrust score-online, plans-and-limits; Arize AX online-evals, Phoenix evaluator-traces; Datadog custom LLM-as-a-judge evaluations; Opik online-evaluation/rules; W&B Weave custom-monitors; Confident AI online-evals; Galileo luna-2; Patronus Lynx / Glider
- docs.typesafe.ai: models, cookbooks/parallel_questions, cookbooks/consistency_noul_cookbook, model-jaggedness/jev-1.13, cookbooks/llm_guardrails, legal
- Latitude, "Real-time eval strategies for LLMs"; Galileo, "Why LLM-as-a-judge fails"; arXiv 2606.15474 "Who Drifted: the System or the Judge?"; arXiv 2606.07810 SLMJury; Anthropic, "Demystifying evals for AI agents"
