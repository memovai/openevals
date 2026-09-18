// Langfuse-compatible batch ingestion (POST /api/public/ingestion).
// Body: { batch: [{ id, type, timestamp, body }], metadata? }
// Event types: trace-create, span-create|update, generation-create|update,
// event-create, agent-create|update, tool-create|update, chain-*, retriever-*,
// embedding-*, guardrail-*, evaluator-*, observation-create|update, score-create, sdk-log.
// Response: 207 { successes: [{id, status}], errors: [{id, status, message}] }
import { Hono } from "hono";
import { z } from "zod";
import type { Repo } from "../db/repo.js";
import { scheduleTrace } from "../eval/worker.js";

const OBS_TYPES: Record<string, string> = {
  span: "SPAN",
  generation: "GENERATION",
  event: "EVENT",
  agent: "AGENT",
  tool: "TOOL",
  chain: "CHAIN",
  retriever: "RETRIEVER",
  embedding: "EMBEDDING",
  guardrail: "GUARDRAIL",
  evaluator: "EVALUATOR",
  observation: "SPAN",
};

const eventSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  timestamp: z.string().optional(),
  body: z.record(z.string(), z.unknown()),
});
const batchSchema = z.object({ batch: z.array(eventSchema).max(1000), metadata: z.unknown().optional() });

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function usageOf(b: Record<string, unknown>): { input?: number; output?: number; total?: number; cost?: number } {
  const u = obj(b.usage) ?? obj(b.usageDetails) ?? {};
  const input = num(u.input) ?? num(u.promptTokens) ?? num(u.input_tokens);
  const output = num(u.output) ?? num(u.completionTokens) ?? num(u.output_tokens);
  const total = num(u.total) ?? num(u.totalTokens) ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  const cd = obj(b.costDetails) ?? {};
  const cost = num(b.totalCost) ?? num(cd.total) ?? num(u.totalCost);
  return { input, output, total, cost };
}

export function applyEvent(repo: Repo, ev: z.infer<typeof eventSchema>, touched: Set<string>): void {
  const b = ev.body;
  const [kind, action] = ev.type.split("-") as [string, string | undefined];

  if (kind === "trace") {
    const id = str(b.id);
    if (!id) throw new Error("trace event requires body.id");
    repo.upsertTrace({
      id,
      name: str(b.name),
      user_id: str(b.userId),
      session_id: str(b.sessionId),
      input: b.input,
      output: b.output,
      expected_output: b.expectedOutput,
      metadata: obj(b.metadata),
      tags: strArr(b.tags),
      release: str(b.release),
      version: str(b.version),
      environment: str(b.environment),
      timestamp: str(b.timestamp) ?? ev.timestamp,
    });
    touched.add(id);
    return;
  }

  if (kind === "score") {
    const traceId = str(b.traceId);
    const name = str(b.name);
    if (!traceId || !name) throw new Error("score event requires body.traceId and body.name");
    const value = b.value;
    const dataType = (str(b.dataType) as "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | undefined) ?? (typeof value === "string" ? "CATEGORICAL" : typeof value === "boolean" ? "BOOLEAN" : "NUMERIC");
    repo.insertScore({
      id: str(b.id),
      trace_id: traceId,
      observation_id: str(b.observationId) ?? null,
      name,
      value: typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : null,
      string_value: typeof value === "string" ? value : null,
      data_type: dataType,
      source: (str(b.source) as "API" | "ANNOTATION" | undefined) ?? "API",
      comment: str(b.comment) ?? null,
      metadata: obj(b.metadata) ?? null,
      evaluator_id: null,
      judgment_id: null,
      timestamp: str(b.timestamp) ?? ev.timestamp,
    });
    return;
  }

  if (kind === "sdk") return; // sdk-log

  const type = OBS_TYPES[kind];
  if (!type) throw new Error(`unknown event type: ${ev.type}`);
  const id = str(b.id);
  const traceId = str(b.traceId);
  if (!id || !traceId) throw new Error(`${ev.type} requires body.id and body.traceId`);
  // Make sure the trace row exists even if the SDK sends observations first.
  if (!repo.getTrace(traceId)) repo.upsertTrace({ id: traceId, timestamp: str(b.startTime) ?? ev.timestamp });
  const usage = usageOf(b);
  const isUpdate = action === "update";
  repo.upsertObservation({
    id,
    trace_id: traceId,
    parent_observation_id: str(b.parentObservationId),
    type: isUpdate ? undefined : (str(b.type)?.toUpperCase() ?? type),
    name: str(b.name),
    start_time: str(b.startTime) ?? (isUpdate ? undefined : ev.timestamp),
    end_time: str(b.endTime),
    completion_start_time: str(b.completionStartTime),
    input: b.input,
    output: b.output,
    metadata: obj(b.metadata),
    level: str(b.level),
    status_message: str(b.statusMessage),
    model: str(b.model),
    model_parameters: obj(b.modelParameters),
    usage_input: usage.input,
    usage_output: usage.output,
    usage_total: usage.total,
    cost_usd: usage.cost,
  });
  repo.touchTrace(traceId);
  touched.add(traceId);
}

export function ingestRoutes(repo: Repo, opts: { evalEnabled: boolean }): Hono {
  const app = new Hono();
  const handler = async (c: { req: { json: () => Promise<unknown> }; json: (v: unknown, status?: 200 | 207 | 400) => Response }) => {
    let parsed: z.infer<typeof batchSchema>;
    try {
      parsed = batchSchema.parse(await c.req.json());
    } catch (e) {
      return c.json({ error: "invalid body", detail: e instanceof Error ? e.message : String(e) }, 400);
    }
    const successes: { id: string; status: number }[] = [];
    const errors: { id: string; status: number; message: string }[] = [];
    const touched = new Set<string>();
    repo.db.exec("BEGIN");
    try {
      for (const ev of parsed.batch) {
        try {
          applyEvent(repo, ev, touched);
          successes.push({ id: ev.id ?? "", status: 201 });
        } catch (e) {
          errors.push({ id: ev.id ?? "", status: 400, message: e instanceof Error ? e.message : String(e) });
        }
      }
      repo.db.exec("COMMIT");
    } catch (e) {
      repo.db.exec("ROLLBACK");
      throw e;
    }
    if (opts.evalEnabled) for (const t of touched) scheduleTrace(repo, t);
    return c.json({ successes, errors }, 207);
  };
  app.post("/api/public/ingestion", handler as never);
  app.post("/api/v1/ingest", handler as never);
  return app;
}
