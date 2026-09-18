# openeva

Cheap, fast observability + eval for agent trajectories.

- **Data model copied from [Langfuse](https://github.com/langfuse/langfuse) (MIT):** `trace → observations (tree) → scores`. Langfuse SDKs can point straight at this server.
- **One process, one SQLite file.** No ClickHouse / Redis / S3. Uses Node's built-in `node:sqlite`, so there are no native dependencies.
- **[jev](https://typesafe.ai) is the judge.** jev does not generate text; it answers typed questions (Choice / Score / Noul) with calibrated probabilities. An "LLM-as-judge" rubric is therefore a set of atomic questions asked in **one request per trace**, and the weights / pass rules live in code. ≈ $0.001 per trace, ~1 s.

## Run

```bash
pnpm install
cp .env.example .env         # add TYPESAFE_API_KEY (+ ANTHROPIC_API_KEY for escalation)
pnpm start                   # http://localhost:3100
pnpm demo                    # sends two synthetic agent runs, prints jev's verdicts
```

Without `TYPESAFE_API_KEY` the server still records traces; evaluation is just off.

## Send traces

**Built-in SDK** (`src/sdk/index.ts`, zero deps):

```ts
import { OpenEva } from "openeva/sdk";
const eva = new OpenEva({ baseUrl: "http://localhost:3100" });

const trace = eva.trace({ name: "research-agent", input: task, tags: ["prod"], expectedOutput: reference /* optional */ });
const agent = trace.agent({ name: "researcher" });
const gen = agent.generation({ name: "plan", model: "claude-sonnet-5", input: messages });
gen.end({ output: plan, usage: { input: 812, output: 120 } });
const tool = agent.tool({ name: "search", input: { q } });
tool.end({ output: results, level: "ERROR", statusMessage: "timeout" }); // levels drive error stats
trace.update({ output: finalAnswer });
await eva.flush();
```

**Langfuse SDKs (any version)**: set `LANGFUSE_HOST=http://localhost:3100`. v2 SDKs hit the batch API (`POST /api/public/ingestion`); v3+/v4 SDKs export OTLP to `POST /api/public/otel/v1/traces`. Both are served. If `OPENEVA_API_KEY` is set, the Langfuse *secret key* must equal it.

**Any OpenTelemetry exporter**: point OTLP/HTTP at `http://localhost:3100/v1/traces` (protobuf or JSON, gzip ok). Span attributes are mapped from Langfuse's OTel conventions (`langfuse.observation.*`, `langfuse.trace.*`, `langfuse.session.id`, …), OTel GenAI semconv (`gen_ai.*`), OpenInference (`openinference.span.kind`, `input.value`, `llm.token_count.*`), OpenLLMetry (`gen_ai.prompt.N.*`) and the Vercel AI SDK (`ai.*`). The root span's input/output become the trace's input/output unless `langfuse.trace.input/output` are set. Set `openeva.trace.expected_output` on the root span to enable outcome grading.

## How evaluation works

1. Every ingested event re-schedules the trace; after `OPENEVA_SETTLE_MS` of quiet the worker picks it up.
2. `eval/state.ts` compacts the trajectory into a JSON `state` under jev's 32k-token budget (per-field truncation → head/tail elision → last-resort clipping). Deterministic, so the state hash is a cache key: identical data is never judged twice.
3. Each enabled evaluator = one `POST /v1/systemone` with all its questions. Answers become `scores` rows (`source = EVAL`): Noul → numeric P(yes); Score → numeric level (+ probabilities/confidence in metadata); Choice → categorical.
4. `composite` (in code) turns the atomic answers into `trajectory_quality` (0–1) and `passed` (boolean).
5. **Escalation.** If jev's minimum `confidence` is below `OPENEVA_REVIEW_CONFIDENCE` (or a Noul lands within `OPENEVA_ESCALATE_NOUL_BAND` of 0.5), the same state and questions go to a reasoning model (`claude-opus-5` by default, needs `ANTHROPIC_API_KEY`) with a strict JSON output schema. Its answers replace the jev scores and its **rationale** lands in each score's `comment`. Without an escalator the judgment is just flagged `needs_review`. Force a second opinion any time with `POST /api/v1/traces/:id/escalate`.
6. The exact `state`, `questions`, raw `answers`, model version, tokens, cost, latency are stored in `judgments` for audit. An escalation judgment points at the jev judgment it replaced via `escalated_from`.

### Trace-level vs observation-level

`target: "trace"` evaluators see the whole compacted trajectory (one request per trace). `target: "observation"` evaluators see one step at a time — `task`, the `step` under review (`step.name`, `step.input`, `step.output`, `step.level`), and `context` (position, parent, the previous steps' names, `final_output`) — and run once per matching observation, filtered by `observationTypes` / `observationNames`. Scores attach to the observation and show up inline in the trajectory tree.

### Built-in evaluators

| name | runs on | questions |
|---|---|---|
| `trajectory` | every trace | `task_completion` (Score 0–2), `instruction_following`, `grounded_in_evidence`, `wasted_effort` (Score 0–2), `tool_use_appropriate`, `recovered_from_errors`, `unsafe_or_out_of_scope_action` (Noul), `failure_mode` (Choice) → composite `trajectory_quality`, `passed` |
| `outcome` | traces with `expected_output` | `matches_expected`, `match_quality` (Score 0–2), `contradicts_expected` → `outcome_quality`, `outcome_passed` |
| `tool_call` | every `TOOL` observation (**disabled by default**: one request per tool call) | `arguments_appropriate`, `result_usefulness` (Score 0–2), `redundant_call` → `tool_call_quality` |

### Custom evaluators

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

Trace-level questions see `task`, `final_output`, `expected_output` (if any), `trajectory[]` (`type`, `name`, `input`, `output`, `level`, `status_message`, `duration_ms`), and `stats`. Observation-level questions (`"target": "observation"`) see `task`, `step`, and `context`. Write questions in English (jev's strongest language); the trajectory itself can be in any language. Transforms: `noul`, `noul_inverted`, `score_norm`, `score_norm_inverted`, `choice_is` (with `option`).

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
| GET/POST/PATCH/DELETE | `/api/v1/evaluators[/:id]` | manage evaluators (`PATCH {enabled}`) |
| POST | `/api/v1/datasets`, `/api/v1/datasets/:name/items` | reference sets |
| POST | `/api/v1/datasets/:name/runs/:run/items` | link a trace to an item; copies `expected_output` onto the trace so `outcome` grades it |
| GET | `/api/v1/datasets/:name/runs` | per-run avg quality / pass rate |
| GET | `/api/v1/stats`, `/api/v1/health` | |

UI: `/` traces, `/traces/:id` trajectory tree + probability bars per question, `/evaluators`, `/datasets`.

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
  eval/builtin.ts  built-in rubrics
  eval/aggregate.ts answers → scores, composite, pass rules
  eval/worker.ts   queue, caching, scheduling
  sdk/index.ts     client SDK
```

## Not yet

Multi-project auth, OTLP metrics/logs (traces only), sampling for high-volume traffic.
