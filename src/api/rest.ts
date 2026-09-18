// JSON API: read traces/scores/judgments, manage evaluators & datasets,
// trigger evaluations. Mirrors Langfuse's /api/public shapes where cheap.
import { Hono } from "hono";
import { z } from "zod";
import type { Repo } from "../db/repo.js";
import { evaluateTrace, escalateJudgment, scheduleTrace, type Judges } from "../eval/worker.js";
import { buildTraceState } from "../eval/state.js";
import { config } from "../config.js";

export function restRoutes(repo: Repo, judges: Judges | null): Hono {
  const app = new Hono();
  const judge = judges?.judge ?? null;

  app.get("/api/v1/health", (c) => c.json({ ok: true, eval: !!judge, model: judge?.model ?? null, escalation: judges?.escalator?.model ?? null }));

  app.get("/api/v1/stats", (c) =>
    c.json({ traces: repo.countTraces(), scores: repo.scoreStats(), judgments: repo.judgmentStats(), queue: repo.queueStats() }),
  );

  // ---- traces ----
  app.get("/api/v1/traces", (c) => {
    const q = c.req.query();
    const traces = repo.listTraces({
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      name: q.name,
      sessionId: q.sessionId,
      userId: q.userId,
      tag: q.tag,
    });
    const scores = repo.scoresForTraces(traces.map((t) => t.id));
    return c.json({ data: traces.map((t) => ({ ...t, scores: scores.get(t.id) ?? [] })) });
  });

  app.get("/api/v1/traces/:id", (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json({ ...t, observations: repo.listObservations(t.id), scores: repo.listScores(t.id), judgments: repo.listJudgments(t.id) });
  });

  /** Preview the exact state jev would receive (debugging compaction / prompts). */
  app.get("/api/v1/traces/:id/state", (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json(buildTraceState(t, repo.listObservations(t.id), config.stateBudgetChars));
  });

  /** Force (re-)evaluation now. ?evaluator=<name> to limit; ?force=1 to bypass the hash cache. */
  app.post("/api/v1/traces/:id/evaluate", async (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (!judge) return c.json({ error: "evaluation disabled: TYPESAFE_API_KEY not set" }, 503);
    const only = c.req.query("evaluator");
    const force = c.req.query("force") === "1";
    const evs = repo.listEvaluators(true).filter((e) => !only || e.name === only);
    const results: Record<string, unknown> = {};
    for (const ev of evs) results[ev.name] = await evaluateTrace(repo, judges!, ev, t.id, { force });
    return c.json({ traceId: t.id, results });
  });

  /** Force a reasoning-model second opinion on the latest jev judgment(s) of this trace. ?evaluator=<name> to limit. */
  app.post("/api/v1/traces/:id/escalate", async (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    const esc = judges?.escalator;
    if (!esc) return c.json({ error: "escalation disabled: ANTHROPIC_API_KEY not set or OPENEVA_ESCALATE=false" }, 503);
    const only = c.req.query("evaluator");
    const results: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const jd of repo.listJudgments(t.id)) {
      if (jd.status !== "ok" || jd.escalated_from) continue;
      const ev = repo.getEvaluator(jd.evaluator_id);
      if (!ev || (only && ev.name !== only)) continue;
      const key = `${ev.id}:${jd.observation_id ?? ""}`;
      if (seen.has(key)) continue; // listJudgments is newest-first: only the latest per unit
      seen.add(key);
      results[`${ev.name}${jd.observation_id ? "@" + jd.observation_id : ""}`] = await escalateJudgment(repo, esc, ev, jd);
    }
    return c.json({ traceId: t.id, results });
  });

  app.post("/api/v1/traces/:id/enqueue", (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    scheduleTrace(repo, t.id, 0);
    return c.json({ ok: true });
  });

  // ---- scores (manual annotation) ----
  const scoreBody = z.object({
    traceId: z.string(),
    observationId: z.string().optional(),
    name: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()]),
    comment: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  app.post("/api/v1/scores", async (c) => {
    const p = scoreBody.safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const b = p.data;
    const row = repo.insertScore({
      trace_id: b.traceId,
      observation_id: b.observationId ?? null,
      name: b.name,
      value: typeof b.value === "number" ? b.value : typeof b.value === "boolean" ? (b.value ? 1 : 0) : null,
      string_value: typeof b.value === "string" ? b.value : null,
      data_type: typeof b.value === "string" ? "CATEGORICAL" : typeof b.value === "boolean" ? "BOOLEAN" : "NUMERIC",
      source: "ANNOTATION",
      comment: b.comment ?? null,
      metadata: b.metadata ?? null,
      evaluator_id: null,
      judgment_id: null,
    });
    return c.json(row, 201);
  });

  // ---- evaluators ----
  const question = z.object({ type: z.enum(["noul", "choice", "score"]), instructions: z.unknown().optional(), criteria: z.unknown().optional() });
  const evaluatorBody = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    target: z.enum(["trace", "observation"]).optional(),
    filter: z
      .object({
        names: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        requiresExpectedOutput: z.boolean().optional(),
        observationTypes: z.array(z.string()).optional(),
        observationNames: z.array(z.string()).optional(),
      })
      .optional(),
    questions: z.record(z.string(), question),
    composite: z.unknown().optional(),
    enabled: z.boolean().optional(),
  });
  app.get("/api/v1/evaluators", (c) => c.json({ data: repo.listEvaluators() }));
  app.get("/api/v1/evaluators/:id", (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    return e ? c.json(e) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/v1/evaluators", async (c) => {
    const p = evaluatorBody.safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const existing = repo.getEvaluatorByName(p.data.name);
    if (existing?.builtin) return c.json({ error: "cannot overwrite a builtin evaluator; create one with a different name or toggle it via PATCH" }, 409);
    return c.json(repo.upsertEvaluator({ ...p.data, filter: p.data.filter ?? null, composite: p.data.composite ?? null }), 201);
  });
  app.patch("/api/v1/evaluators/:id", async (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { enabled?: boolean };
    if (typeof body.enabled === "boolean") repo.setEvaluatorEnabled(e.id, body.enabled);
    return c.json(repo.getEvaluator(e.id));
  });
  app.delete("/api/v1/evaluators/:id", (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    if (e.builtin) return c.json({ error: "builtin evaluators can only be disabled" }, 409);
    repo.deleteEvaluator(e.id);
    return c.json({ ok: true });
  });

  // ---- datasets ----
  app.get("/api/v1/datasets", (c) => c.json({ data: repo.listDatasets() }));
  app.post("/api/v1/datasets", async (c) => {
    const p = z.object({ name: z.string().min(1), description: z.string().optional(), metadata: z.unknown().optional() }).safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    return c.json(repo.upsertDataset(p.data), 201);
  });
  app.get("/api/v1/datasets/:name/items", (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json({ data: repo.listDatasetItems(d.id as string) });
  });
  app.post("/api/v1/datasets/:name/items", async (c) => {
    const d = repo.getDatasetByName(c.req.param("name")) ?? repo.upsertDataset({ name: c.req.param("name") });
    const p = z
      .object({ items: z.array(z.object({ id: z.string().optional(), input: z.unknown(), expectedOutput: z.unknown().optional(), metadata: z.unknown().optional() })) })
      .safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const ids = p.data.items.map((it) => repo.insertDatasetItem({ id: it.id, dataset_id: d.id as string, input: it.input, expected_output: it.expectedOutput, metadata: it.metadata }));
    return c.json({ ids }, 201);
  });
  /** Link a trace to a dataset item under a run name; copies expected_output onto the trace so `outcome` can grade it. */
  app.post("/api/v1/datasets/:name/runs/:run/items", async (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "dataset not found" }, 404);
    const p = z.object({ datasetItemId: z.string(), traceId: z.string() }).safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const item = repo.getDatasetItem(p.data.datasetItemId);
    if (!item) return c.json({ error: "item not found" }, 404);
    repo.linkRunItem({ dataset_id: d.id as string, run_name: c.req.param("run"), dataset_item_id: p.data.datasetItemId, trace_id: p.data.traceId });
    if (item.expected_output !== null && item.expected_output !== undefined) {
      repo.upsertTrace({ id: p.data.traceId, expected_output: item.expected_output });
      if (config.evalEnabled) scheduleTrace(repo, p.data.traceId);
    }
    return c.json({ ok: true }, 201);
  });
  app.get("/api/v1/datasets/:name/runs", (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json({ data: repo.listRuns(d.id as string) });
  });
  app.get("/api/v1/datasets/:name/runs/:run", (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "not found" }, 404);
    const items = repo.listRunItems(d.id as string, c.req.param("run"));
    const scores = repo.scoresForTraces(items.map((i) => i.trace_id as string));
    return c.json({ data: items.map((i) => ({ ...i, scores: scores.get(i.trace_id as string) ?? [] })) });
  });

  return app;
}
