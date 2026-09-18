# openevals

**Online eval for agents: every trace, every step, written back to the observability tool you already use.**

Langfuse (and the other observability platforms) grade production traces with your GPT/Claude key at $0.01–0.10 a call, so they sample 1–10% and judge the trace as a whole. openevals uses [jev](https://typesafe.ai), a typed judge at $0.042 per million tokens and ~100 ms, to grade **100% of traces and every step inside them**, then writes the scores back into Langfuse where your team already looks. It also tells you which of your metrics jev can be trusted on.

- **Langfuse connector.** Pulls settled observations from `GET /api/public/v2/observations` (the only real-time read path), judges them, and writes scores back via the ingestion API with `observationId` for per-step scores and jev's probabilities in `metadata`. Failed or low-confidence traces are pushed into a Langfuse annotation queue; the human verdicts flow back for calibration. Zero code changes on your side: paste three env vars.
- **Every step is graded.** Each tool call and LLM step gets four atomic questions (progress / on task / redundant / corrective), judged concurrently, with the previous steps as context — something Langfuse's own observation-level evaluators cannot see. Answers fold into the trace-level state so long runs are graded from a complete skeleton, and roll up into credit-assignment metrics (`first_off_task_step`, `longest_stall`, `wasted_fraction`, `error_recovery_rate`).
- **Rubrics designed for jev, with feedback.** jev answers typed questions (Noul / Score / Choice) and never writes prose; weights and pass rules live in code. Lint, per-question calibration against human verdicts, a backtest endpoint, templates per agent type, and a compiler that turns a prose rubric into jev questions. See [docs/designing-for-jev.md](docs/designing-for-jev.md).
- **Budgeted.** A process-wide limiter keeps jev under its published 1,200 requests/min, per-step grading samples very long runs, and an optional daily spend cap pauses model graders. Background: [docs/online-eval-research.md](docs/online-eval-research.md).
- **One process, one SQLite file.** The local store holds the trace snapshot, every judgment (exact state and answers, for audit), the hash cache, and evaluators. Langfuse stays the system of record for traces. Direct ingestion (Langfuse-compatible batch API, OTLP, built-in SDK) still works as a fast lane for setups that need second-level latency.

## Run with Langfuse

```bash
pnpm install
cp .env.example .env
# TYPESAFE_API_KEY=...                       jev
# LANGFUSE_HOST=https://cloud.langfuse.com  LANGFUSE_PUBLIC_KEY=pk-lf-...  LANGFUSE_SECRET_KEY=sk-lf-...
# OPENEVALS_PUBLIC_URL=https://evals.example.com   (deep links from Langfuse scores back to the judgment page)
# LANGFUSE_REVIEW_QUEUE_ID=...               optional: failed / unsure traces land in this annotation queue
pnpm start                                   # http://localhost:3100 — the status page shows the connector loop
```

What happens every `LANGFUSE_POLL_MS` (30 s):

1. **Pull.** Observations that started in `[watermark − LANGFUSE_OVERLAP_S, now − LANGFUSE_SETTLE_S)` are fetched (cursor-paged, `fields=basic,io,metadata,model,usage,trace_context`), grouped by trace, and upserted locally. A trace whose root started before the window is fetched whole by `traceId` so its task is known. Filters: `LANGFUSE_ENVIRONMENTS`, `LANGFUSE_TRACE_NAMES`.
2. **Judge.** Code graders → per-step `step` evaluator → trace-level `trajectory` / `outcome`, as below. Identical states are never judged twice.
3. **Write back.** Every EVAL score becomes a Langfuse score (`source=API`; `EVAL` is reserved for Langfuse's own evaluators): `value` + `dataType`, `observationId` for per-step scores, `comment` with the level description or rationale, `metadata.openevals` with probabilities, confidence, model, and a link to the judgment page. `LANGFUSE_WRITE_BACK_SCORES` / `LANGFUSE_WRITE_BACK_STEPS` narrow what is written. Traces that fail a pass gate or have a low-confidence judgment are added to `LANGFUSE_REVIEW_QUEUE_ID`, once.
4. **Annotations.** Human scores (`source=ANNOTATION`) are pulled back; the one named `LANGFUSE_VERDICT_SCORE` (default `passed`) becomes the human verdict for `/calibration` and `POST /api/v1/evaluators/:id/backtest`.

`GET /api/v1/sync` shows watermarks, counters and last errors; `POST /api/v1/sync/poll|writeback|annotations` runs a loop step now. Without `TYPESAFE_API_KEY` only the free code graders run.

## Run without Langfuse (direct ingestion, the fast lane)

```bash
pnpm start                   # http://localhost:3100
pnpm demo                    # sends two synthetic agent runs, prints jev's verdicts
```

Traces sent straight to this server are graded the same way; scores stay local. Use this when you need judgments within seconds of a step (online early-stop) or have no Langfuse.

## Send traces directly

**Built-in SDK** (`src/sdk/index.ts`, zero deps):

```ts
import { OpenEvals } from "openevals/sdk";
const eva = new OpenEvals({ baseUrl: "http://localhost:3100" });

const trace = eva.trace({ name: "research-agent", input: task, tags: ["prod"], expectedOutput: reference /* optional */ });
const agent = trace.agent({ name: "researcher" });
const gen = agent.generation({ name: "plan", model: "claude-sonnet-5", input: messages });
gen.end({ output: plan, usage: { input: 812, output: 120 } });
const tool = agent.tool({ name: "search", input: { q } });
tool.end({ output: results, level: "ERROR", statusMessage: "timeout" }); // levels drive error stats
trace.update({ output: finalAnswer });
await eva.flush();
```

**Langfuse SDKs (any version)**: set `LANGFUSE_HOST=http://localhost:3100`. v2 SDKs hit the batch API (`POST /api/public/ingestion`); v3+/v4 SDKs export OTLP to `POST /api/public/otel/v1/traces`. Both are served. If `OPENEVALS_API_KEY` is set, the Langfuse *secret key* must equal it.

**Any OpenTelemetry exporter**: point OTLP/HTTP at `http://localhost:3100/v1/traces` (protobuf or JSON, gzip ok). Span attributes are mapped from Langfuse's OTel conventions (`langfuse.observation.*`, `langfuse.trace.*`, `langfuse.session.id`, …), OTel GenAI semconv (`gen_ai.*`), OpenInference (`openinference.span.kind`, `input.value`, `llm.token_count.*`), OpenLLMetry (`gen_ai.prompt.N.*`) and the Vercel AI SDK (`ai.*`). The root span's input/output become the trace's input/output unless `langfuse.trace.input/output` are set. Set `openevals.trace.expected_output` on the root span to enable outcome grading.

## How evaluation works

1. Every ingested event re-schedules the trace; after `OPENEVALS_SETTLE_MS` of quiet the worker picks it up. For one trace the evaluators run in order: code graders (free) → per-step graders → trace-level graders; different traces run concurrently.
2. **Per-step grading.** The `step` evaluator judges every TOOL and GENERATION step with one small jev request each, `OPENEVALS_STEP_CONCURRENCY` (8) at a time. Each step's state is the task, the step, the previous `OPENEVALS_STEP_CONTEXT` (8) steps with clipped input/output, and the most recent earlier error. Runs longer than `OPENEVALS_STEP_MAX` (150) steps are sampled evenly. Answers attach to the observation; code rolls them up into trace-level metrics (`progress_mean`, `longest_stall`, `wasted_fraction`, `first_off_task_step`, `error_recovery_rate`, …).
3. `eval/state.ts` compacts the trajectory into a JSON `state` under jev's 32k-token budget: per-field truncation → keep head and tail steps with input/output while the **middle steps stay as a digest** (name, level, per-step `judgments`) → counter-only elision → last-resort clipping. The per-step answers and their `step_summary` ride along, so the trace-level grader sees every step. Deterministic, so the state hash is a cache key: identical data is never judged twice.
4. Each enabled evaluator = one `POST /v1/systemone` with all its questions. Answers become `scores` rows (`source = EVAL`): Noul → numeric P(yes); Score → numeric level (+ probabilities/confidence in metadata); Choice → categorical.
5. `composite` (in code) turns the atomic answers into `trajectory_quality` (0–1) and `passed` (boolean). Per-step metrics are diagnostics; pass/fail comes from the outcome.
5. **Escalation.** If jev's minimum `confidence` is below `OPENEVALS_REVIEW_CONFIDENCE` (or a Noul lands within `OPENEVALS_ESCALATE_NOUL_BAND` of 0.5), the same state and questions go to a reasoning model (`claude-opus-5` by default, needs `ANTHROPIC_API_KEY`) with a strict JSON output schema. Its answers replace the jev scores and its **rationale** lands in each score's `comment`. Without an escalator the judgment is just flagged `needs_review`. Force a second opinion any time with `POST /api/v1/traces/:id/escalate`.
6. The exact `state`, `questions`, raw `answers`, model version, tokens, cost, latency are stored in `judgments` for audit. An escalation judgment points at the jev judgment it replaced via `escalated_from`.

### Trace-level vs observation-level

`target: "trace"` evaluators see the whole compacted trajectory (one request per trace). `target: "observation"` evaluators see one step at a time — `task`, the `step` under review (`step.name`, `step.input`, `step.output`, `step.level`), and `context` (position, parent, the previous steps' names, `final_output`) — and run once per matching observation, filtered by `observationTypes` / `observationNames`. Scores attach to the observation and show up inline in the trajectory tree.

### Built-in evaluators

| name | runs on | questions |
|---|---|---|
| `sanity` | every trace, **code grader, free** | `output_nonempty`, `no_unresolved_error`, `max_steps ≤ 200`, `max_repeated_tool_call ≤ 5` → `sanity_score`, `sanity_passed` |
| `step` | every `TOOL` and `GENERATION` observation, concurrently | `progress` (Score 0–2: regressed / none / progress), `on_task`, `redundant`, `corrective` (Noul) → per-step `step_quality`; trace-level roll-ups `progress_mean`, `longest_stall`, `wasted_fraction`, `first_off_task_step`, `off_task_steps`, `error_recovery_rate`, `mean_steps_to_recover`, `step_quality_mean` |
| `trajectory` | every trace | `task_completion` (Score 0–2), `instruction_following`, `grounded_in_evidence`, `wasted_effort` (Score 0–2), `tool_use_appropriate`, `recovered_from_errors`, `unsafe_or_out_of_scope_action` (Noul), `failure_mode` (Choice) → composite `trajectory_quality`, `passed` |
| `outcome` | traces with `expected_output` | `matches_expected`, `match_quality` (Score 0–2), `contradicts_expected` → `outcome_quality`, `outcome_passed` |
| `tool_call` | every `TOOL` observation (**disabled by default**: overlaps with `step`) | `arguments_appropriate`, `result_usefulness` (Score 0–2), `redundant_call` → `tool_call_quality` |

### Code graders (deterministic, free)

Anything with a crisp answer should not cost a model call. A `kind: "code"` evaluator is a list of checks; each becomes a BOOLEAN score, plus `<name>_score` (fraction passed) and a pass score (`passed` by default, or `composite.passName`).

```bash
curl -X POST localhost:3100/api/v1/evaluators -H 'content-type: application/json' -d '{
  "name": "booking-limits",
  "filter": { "names": ["travel-agent"] },
  "checks": [
    { "type": "required_tools", "tools": ["flight_search"] },
    { "type": "forbidden_tools", "tools": ["send_email"] },
    { "type": "max_tool_calls", "value": 8 },
    { "type": "max_repeated_tool_call", "value": 2 },
    { "type": "output_regex", "pattern": "\\$\\d+" },
    { "type": "output_contains_expected" }
  ]
}'
```

Check types: `output_nonempty`, `output_contains`, `output_not_contains`, `output_regex`, `output_equals_expected`, `output_contains_expected` (normalised by default), `output_max_chars`, `output_json`, `max_steps`, `max_tool_calls`, `max_llm_calls`, `max_duration_ms`, `max_total_tokens`, `max_cost_usd`, `no_errors`, `no_unresolved_error`, `required_tools`, `forbidden_tools`, `max_repeated_tool_call`. Per the eval guide, prefer grading *what was produced* (output checks, final state) over rigid step sequences; `required_tools` is there for the cases where a tool call genuinely is the outcome (e.g. "the refund was processed").

### Custom jev evaluators

```bash
curl -X POST localhost:3100/api/v1/evaluators -H 'content-type: application/json' -d '{
  "name": "support-tone",
  "filter": { "names": ["support-agent"] },
  "questions": {
    "polite":   { "type": "noul",  "instructions": "Is `final_output` polite and free of blame toward the user?" },
    "empathy":  { "type": "score", "instructions": "How much empathy does `final_output` show?",
                  "criteria": ["None: purely transactional", "Some: acknowledges the problem", "Strong: acknowledges feelings and takes ownership"] }
  },
  "composite": { "name": "tone_quality", "terms": [
    { "q": "polite", "weight": 0.5, "transform": "noul" },
    { "q": "empathy", "weight": 0.5, "transform": "score_norm" } ],
    "pass": [ { "q": "polite", "op": ">=", "value": 0.5 } ], "passName": "tone_passed" }
}'
```

Trace-level questions see `task`, `final_output`, `expected_output` (if any), `trajectory[]` (`type`, `name`, `input`, `output`, `level`, `status_message`, `duration_ms`, per-step `judgments`), `stats` and `step_summary`. Observation-level questions (`"target": "observation"`) see `task`, `step`, and `context` (`previous_steps` with clipped I/O, `previous_steps_omitted`, `last_error`, `final_output`). Write questions in English (jev's strongest language); the trajectory itself can be in any language. Transforms: `noul`, `noul_inverted`, `score_norm`, `score_norm_inverted`, `choice_is` (with `option`).

Creating an evaluator runs **lint** first: errors (a composite term pointing at a missing question, a transform of the wrong type, a numeric "rate 1–10" scale, a field that only exists in the other target's state) return 422 with the findings; `?force=1` saves anyway. Warnings and notes come back with the saved evaluator and are shown on `/evaluators`.

### Designing rubrics for jev: templates, compiler, per-question calibration

jev answers one typed question at a time, from the state alone, without reasoning or prose. A rubric written for a text-generating judge ("rate the overall quality and explain") has to be decomposed. openevals gives you three ways in, and a feedback loop ([docs/designing-for-jev.md](docs/designing-for-jev.md) has the full guide and conversion table):

```bash
# 1. start from a template (coding-agent · research-agent · support-agent · browser-agent)
curl localhost:3100/api/v1/templates
curl -X POST localhost:3100/api/v1/evaluators/from-template -H 'content-type: application/json' \
  -d '{"template":"coding-agent","name":"my-coder","filter":{"names":["my-agent"]}}'

# 2. compile a prose rubric into jev questions + composite (needs ANTHROPIC_API_KEY); linted and repaired once
curl -X POST localhost:3100/api/v1/evaluators/compile -H 'content-type: application/json' \
  -d '{"name":"refund-agent","rubric":"Verify the order before refunding; never refund over $200 without escalating; stay polite.","save":true}'

# 3. lint a draft without saving
curl -X POST localhost:3100/api/v1/evaluators/lint -H 'content-type: application/json' -d '{"questions":{...},"composite":{...}}'

# then: which question should I rewrite? (undecided / low-confidence rate, constancy, AUC vs the human verdict, false passes)
curl localhost:3100/api/v1/calibration/questions?evaluator=refund-agent
# re-run an edited evaluator on the latest human-labeled traces, cache bypassed, and get the same diagnostics
curl -X POST localhost:3100/api/v1/evaluators/refund-agent/backtest?limit=30
```

## Datasets, trials, pass@k / pass^k

A dataset holds tasks (`input`, `expected_output`); a run links each trial's trace to its item. Run the same item several times to get **pass@k** (at least one of k trials passed) and **pass^k** (all k passed, the reliability bar). `GET /api/v1/datasets/:name/runs/:run` returns both plus per-item pass rates; items with 0 passes across ≥3 trials are flagged `suspect_broken` (the guide: "0% pass@100 is most often a broken task"). Add `?compare=<other run>` for `regressions` / `fixes`. `?pass=<score>` picks which pass score counts (default `passed`; all pass-type scores on a trace must be true).

```bash
curl -X POST localhost:3100/api/v1/datasets/booking/items -H 'content-type: application/json' \
  -d '{"items":[{"id":"sfo-jfk","input":"cheapest direct SFO→JFK on 2026-10-03, max $400","expectedOutput":"…"}]}'
# for each trial: run your agent with tracing on, then
curl -X POST localhost:3100/api/v1/datasets/booking/runs/v12/items -H 'content-type: application/json' \
  -d '{"datasetItemId":"sfo-jfk","traceId":"<trace id from the run>"}'
curl 'localhost:3100/api/v1/datasets/booking/runs/v12?compare=v11'
```

## Humans in the loop: review queue and calibration

- `/review` lists traces that failed, had low-confidence judgments, or errored. Read the transcript; press **pass** / **fail** on the trace page (or `POST /api/v1/scores` with `name: "passed"`) — that writes an ANNOTATION score.
- `/calibration` (`GET /api/v1/calibration`) compares every EVAL score against the ANNOTATION of the same name on the same trace: agreement, Cohen's κ, MAE, Pearson r, and **false pass** (grader said pass, human said fail — the direction that hides real failures). This is how you know whether to trust jev on your domain and where to tighten a rubric.
- The second table on `/calibration` (`GET /api/v1/calibration/questions`) looks at **each jev question on its own**: how often jev is undecided or unconfident on it (vague criteria), whether its answer is nearly constant on your traffic (not discriminating), how well it separates human-pass from human-fail traces (AUC), and how many false passes it produces, with a plain-language diagnosis of what to change. `POST /api/v1/evaluators/:id/backtest` re-measures an edited evaluator on the labeled traces before it touches production.
- The trace page shows a per-step **progress strip** (green progress · amber none · red regressed; off-task steps outlined) with the roll-up line under it, so the first place a long run went wrong is one glance away.

## How this maps to Anthropic's "Demystifying evals for AI agents"

| guide | openevals |
|---|---|
| Three grader types: code, model, human | `kind: "code"` evaluators (free), jev evaluators (typed questions), ANNOTATION scores via UI/API |
| "grade each dimension with an isolated LLM-as-judge" | jev evaluates every question independently against the same state — one request, isolated judgments by construction |
| Long-horizon agents: per-step signal without brittle step-matching | `step` evaluator grades every step concurrently; answers fold into the trace-level state and roll up into progress / stall / waste / recovery metrics that diagnose, while pass/fail stays on the outcome |
| "give the grader a way out" | Noul ≈ 0.5 and low `confidence` trigger `needs_review` / escalation; `failure_mode` has `cannot_determine` |
| Partial credit, weighted / binary / hybrid scoring | `composite.terms` (weighted) + `composite.pass` (binary gates) |
| Grade outcomes, avoid brittle step-checking | trajectory evaluator weights `task_completion` 0.4, process questions low; code checks target output/state |
| Trials, pass@k, pass^k, broken-task detection | dataset runs report all three; `suspect_broken` on 0/k items |
| Capability → regression graduation | `?compare=<run>` returns `regressions` / `fixes`; run pass^k against your regression set in CI |
| Calibrate model graders against humans | `/calibration` on paired EVAL / ANNOTATION scores; per-question AUC / undecided rate / false passes; `backtest` an edited rubric on labeled traces |
| Read the transcripts | `/review` queue, full trajectory tree, exact state and answers stored per judgment |

## API

| method | path | |
|---|---|---|
| POST | `/api/public/ingestion`, `/api/v1/ingest` | Langfuse batch events |
| POST | `/api/public/otel/v1/traces`, `/v1/traces` | OTLP/HTTP traces (protobuf or JSON) |
| GET | `/api/v1/traces?name=&tag=&sessionId=&limit=` | list with scores |
| GET | `/api/v1/traces/:id` | trace + observations + scores + judgments |
| GET | `/api/v1/traces/:id/state` | preview the exact state jev will see |
| POST | `/api/v1/traces/:id/evaluate?evaluator=&force=1` | judge now, synchronously |
| POST | `/api/v1/traces/:id/escalate?evaluator=` | reasoning-model second opinion on the latest judgment(s) |
| POST | `/api/v1/scores` | manual annotation |
| GET/POST/PATCH/DELETE | `/api/v1/evaluators[/:id]` | manage evaluators (`PATCH {enabled}`); POST lints first (422 on errors, `?force=1`) |
| POST | `/api/v1/evaluators/lint` | lint an evaluator body without saving |
| GET | `/api/v1/evaluators/:id/lint` | lint findings for a saved evaluator |
| POST | `/api/v1/evaluators/:id/backtest?limit=` | re-run on the latest human-labeled traces (cache bypassed) + per-question diagnostics |
| GET | `/api/v1/templates[/:id]` | starter rubrics per agent type |
| POST | `/api/v1/evaluators/from-template` | copy a template under your name/filter |
| POST | `/api/v1/evaluators/compile` | prose rubric → jev evaluator (`{name, rubric, agent?, examples?, target?, filter?, save?}`; needs `ANTHROPIC_API_KEY`) |
| GET | `/api/v1/calibration/questions?evaluator=` | per-question diagnostics and rewrite suggestions |
| POST | `/api/v1/datasets`, `/api/v1/datasets/:name/items` | reference sets |
| POST | `/api/v1/datasets/:name/runs/:run/items` | link a trace to an item; copies `expected_output` onto the trace so `outcome` grades it |
| GET | `/api/v1/datasets/:name/runs` | list runs |
| GET | `/api/v1/datasets/:name/runs/:run?compare=&pass=` | pass@1 / pass@k / pass^k, per-item, regressions |
| GET | `/api/v1/review` | traces needing a human look |
| GET | `/api/v1/calibration` | grader-vs-human agreement per score |
| GET | `/api/v1/sync` | connector watermarks, counters, last errors; jev limiter and daily spend |
| POST | `/api/v1/sync/poll`, `/api/v1/sync/writeback`, `/api/v1/sync/annotations` | run one connector step now |
| GET | `/api/v1/stats`, `/api/v1/health` | |

UI: `/` status (connector loop, jev budget, recently judged), `/evaluators` (with lint and templates), `/calibration` (score-level and per-question tables), `/review`, `/traces` judgments list, `/traces/:id` progress strip + trajectory tree + probability bars per question, deep link to Langfuse. `/datasets` (pass@k table) is kept for direct-ingestion setups.

## Layout

```
src/
  server.ts        compose app + worker
  config.ts        env
  db/schema.sql    Langfuse-shaped tables + evaluators/judgments/eval_queue/datasets
  db/repo.ts       queries
  api/ingest.ts    Langfuse batch ingestion
  api/otel.ts      OTLP/HTTP ingestion
  otel/decode.ts   protobuf/JSON OTLP → spans (proto files vendored in otel/proto)
  otel/map.ts      span attributes → Langfuse-shaped trace/observation
  api/rest.ts      JSON API
  ui/pages.ts      server-rendered pages
  eval/state.ts    trajectory → jev state (compaction + hash)
  eval/jev.ts      TypeSafe SDK wrapper
  eval/escalate.ts Claude second opinion for low-confidence judgments
  eval/builtin.ts  built-in rubrics + sanity checks
  eval/code.ts     deterministic code graders
  eval/metrics.ts  pass@k / pass^k / regressions / calibration
  eval/aggregate.ts answers → scores, composite, pass rules
  eval/steps.ts    per-step answers → trace state judgments + credit-assignment roll-ups
  eval/lint.ts     static checks for jev-shaped rubrics
  eval/diagnostics.ts per-question calibration (undecided rate, constancy, AUC vs human verdict)
  eval/templates.ts starter rubrics per agent type
  eval/compile.ts  prose rubric → jev questions (Claude, structured output, lint + one repair)
  eval/worker.ts   queue, per-trace ordering, concurrent per-step judging, caching, daily budget
  sources/langfuse/client.ts   v2 observations · ingestion · v3 scores · annotation queues
  sources/langfuse/map.ts      Langfuse observations → trace/observation rows
  sources/langfuse/sync.ts     pull / write-back / annotation loops with watermarks
  sdk/index.ts     client SDK
```

## Not yet

Other sources behind the same connector shape (Arize Phoenix, LangSmith); reading Langfuse dataset runs for pass@k; Langfuse score configs so BOOLEAN / CATEGORICAL scores render with their categories; multi-project auth; OTLP metrics/logs (traces only).
