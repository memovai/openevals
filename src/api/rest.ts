// JSON API: read traces/scores/judgments, manage evaluators & datasets,
// trigger evaluations. Mirrors Langfuse's /api/public shapes where cheap.
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Repo } from "../db/repo.js";
import { evaluateTrace, escalateJudgment, orderEvaluators, stepContext, type Judges } from "../eval/worker.js";
import { buildTraceState } from "../eval/state.js";
import { runReport, compareRuns, calibration } from "../eval/metrics.js";
import { questionDiagnostics } from "../eval/diagnostics.js";
import { lintEvaluator, hasErrors } from "../eval/lint.js";
import { templates, templateById } from "../eval/templates.js";
import { compileRubric, type Compiler } from "../eval/compile.js";
import { config } from "../config.js";
import { jevLimiter } from "../eval/jev.js";
import type { LangfuseSync } from "../sources/langfuse/sync.js";

export interface RestOptions {
  /** natural-language rubric → jev evaluator; null disables POST /api/v1/evaluators/compile */
  compiler?: Compiler | null;
  /** Langfuse connector, when configured */
  langfuse?: LangfuseSync | null;
}

export function restRoutes(repo: Repo, judges: Judges, schedule: (traceId: string, settleMs?: number) => void, opts: RestOptions = {}): Hono {
  const app = new Hono();
  const judge = judges.judge;
  const compiler = opts.compiler ?? null;

  const langfuse = opts.langfuse ?? null;
  app.get("/api/v1/health", (c) => c.json({ ok: true, eval: !!judge, model: judge?.model ?? null, escalation: judges.escalator?.model ?? null, compiler: compiler?.model ?? null, codeGraders: true, source: langfuse ? "langfuse" : "local" }));

  // ---- connector ----
  const startOfDay = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();
  app.get("/api/v1/sync", (c) =>
    c.json({
      source: langfuse ? "langfuse" : "local",
      langfuse: langfuse ? langfuse.status() : null,
      jev: { ...jevLimiter.stats, spent_today_usd: repo.judgmentCostSince(startOfDay()), daily_budget_usd: config.dailyBudgetUsd || null },
      queue: repo.queueStats(),
    }),
  );
  const syncAction = (fn: (lf: LangfuseSync) => Promise<unknown>) => async (c: Context) => {
    if (!langfuse) return c.json({ error: "langfuse connector not configured (LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)" }, 503);
    try {
      return c.json({ ok: true, result: await fn(langfuse) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  };
  /** Run one pull / write-back / annotation pull now (the loops also run on their timers). */
  app.post("/api/v1/sync/poll", syncAction((lf) => lf.pollOnce()));
  app.post("/api/v1/sync/writeback", syncAction((lf) => lf.writeBackOnce()));
  app.post("/api/v1/sync/annotations", syncAction((lf) => lf.pullAnnotationsOnce()));

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
    const obs = repo.listObservations(t.id);
    return c.json(buildTraceState(t, obs, config.stateBudgetChars, stepContext(repo, t, obs)));
  });

  /** Force (re-)evaluation now. ?evaluator=<name> to limit; ?force=1 to bypass the hash cache. */
  app.post("/api/v1/traces/:id/evaluate", async (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    const only = c.req.query("evaluator");
    const force = c.req.query("force") === "1";
    const evs = orderEvaluators(repo.listEvaluators(true).filter((e) => !only || e.name === only));
    const results: Record<string, unknown> = {};
    for (const ev of evs) results[ev.name] = await evaluateTrace(repo, judges, ev, t.id, { force });
    return c.json({ traceId: t.id, results });
  });

  /** Force a reasoning-model second opinion on the latest jev judgment(s) of this trace. ?evaluator=<name> to limit. */
  app.post("/api/v1/traces/:id/escalate", async (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    const esc = judges.escalator;
    if (!esc) return c.json({ error: "escalation disabled: ANTHROPIC_API_KEY not set or OPENEVALS_ESCALATE=false" }, 503);
    const only = c.req.query("evaluator");
    const results: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const jd of repo.listJudgments(t.id)) {
      if (jd.status !== "ok" || jd.escalated_from || jd.model === "code") continue; // code graders have nothing to second-guess
      const ev = repo.getEvaluator(jd.evaluator_id);
      if (!ev || ev.kind === "code" || (only && ev.name !== only)) continue;
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
    schedule(t.id, 0);
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
  const check = z.object({ name: z.string().optional(), type: z.string() }).passthrough();
  const evaluatorBody = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(["jev", "code"]).optional(),
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
    questions: z.record(z.string(), question).optional(),
    checks: z.array(check).optional(),
    composite: z.unknown().optional(),
    enabled: z.boolean().optional(),
  });
  const lintOf = (e: { kind: "jev" | "code"; target: "trace" | "observation"; filter: unknown; questions: Record<string, unknown>; composite: unknown }) =>
    lintEvaluator({ kind: e.kind, target: e.target, filter: e.filter as never, questions: e.questions, composite: e.composite });
  app.get("/api/v1/evaluators", (c) => c.json({ data: repo.listEvaluators().map((e) => ({ ...e, lint: lintOf(e) })) }));

  /** Lint an evaluator body without saving it (same shape as POST /api/v1/evaluators). */
  app.post("/api/v1/evaluators/lint", async (c) => {
    const p = evaluatorBody.partial({ name: true }).safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const kind = p.data.kind ?? (p.data.checks ? "code" : "jev");
    const questions = kind === "code" ? { checks: p.data.checks ?? [] } : (p.data.questions ?? {});
    const findings = lintEvaluator({ kind, target: p.data.target ?? "trace", filter: p.data.filter ?? null, questions, composite: p.data.composite ?? null });
    return c.json({ ok: !hasErrors(findings), findings });
  });

  /** Starter rubrics per agent type, already shaped for jev. */
  app.get("/api/v1/templates", (c) => c.json({ data: templates.map((t) => ({ id: t.id, title: t.title, description: t.description, target: t.target, questions: Object.keys(t.questions), composite: t.composite.name })) }));
  app.get("/api/v1/templates/:id", (c) => {
    const t = templateById(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  /** Copy a template under your own name (+ filter) as an editable evaluator. */
  app.post("/api/v1/evaluators/from-template", async (c) => {
    const p = z.object({ template: z.string(), name: z.string().min(1), filter: evaluatorBody.shape.filter, enabled: z.boolean().optional() }).safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const t = templateById(p.data.template);
    if (!t) return c.json({ error: `unknown template; one of ${templates.map((x) => x.id).join(", ")}` }, 404);
    if (repo.getEvaluatorByName(p.data.name)?.builtin) return c.json({ error: "cannot overwrite a builtin evaluator" }, 409);
    const row = repo.upsertEvaluator({ name: p.data.name, description: `${t.title}: ${t.description} (from template ${t.id})`, kind: "jev", target: t.target, filter: p.data.filter ?? t.filter ?? null, questions: t.questions, composite: t.composite, enabled: p.data.enabled ?? true });
    return c.json({ ...row, lint: lintOf(row) }, 201);
  });

  /**
   * Compile a natural-language rubric into a jev evaluator (typed atomic questions + composite), lint it,
   * and optionally save it. Needs ANTHROPIC_API_KEY. Body: { name, rubric, target?, agent?, examples?, filter?, save? }.
   */
  app.post("/api/v1/evaluators/compile", async (c) => {
    if (!compiler) return c.json({ error: "rubric compiler disabled: ANTHROPIC_API_KEY not set" }, 503);
    const p = z
      .object({
        name: z.string().min(1),
        rubric: z.string().min(1),
        target: z.enum(["trace", "observation"]).optional(),
        agent: z.string().optional(),
        examples: z.array(z.object({ summary: z.string(), verdict: z.enum(["pass", "fail"]), why: z.string().optional() })).optional(),
        filter: evaluatorBody.shape.filter,
        save: z.boolean().optional(),
      })
      .safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    if (repo.getEvaluatorByName(p.data.name)?.builtin) return c.json({ error: "cannot overwrite a builtin evaluator" }, 409);
    try {
      const out = await compileRubric(compiler, { name: p.data.name, rubric: p.data.rubric, target: p.data.target, agent: p.data.agent, examples: p.data.examples });
      const body = { name: p.data.name, description: out.evaluator.description, kind: "jev" as const, target: out.evaluator.target, filter: p.data.filter ?? null, questions: out.evaluator.questions, composite: out.evaluator.composite };
      let saved = null;
      if (p.data.save && !hasErrors(out.lint)) saved = repo.upsertEvaluator(body);
      return c.json({ evaluator: body, notes: out.evaluator.notes, lint: out.lint, ok: !hasErrors(out.lint), saved, model: out.model, attempts: out.attempts, costUsd: out.costUsd }, saved ? 201 : 200);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get("/api/v1/evaluators/:id", (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    return e ? c.json({ ...e, lint: lintOf(e) }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/v1/evaluators/:id/lint", (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    const findings = lintOf(e);
    return c.json({ ok: !hasErrors(findings), findings });
  });
  /**
   * Backtest: run this evaluator (force, bypassing the cache) on the most recent human-labeled traces and report,
   * per question, how well its answers separate human pass from human fail. ?limit=<n> labeled traces (default 30).
   */
  app.post("/api/v1/evaluators/:id/backtest", async (c) => {
    const e = repo.getEvaluator(c.req.param("id")) ?? repo.getEvaluatorByName(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    if (e.kind !== "jev") return c.json({ error: "backtest applies to jev evaluators" }, 400);
    if (!judge) return c.json({ error: "no judge configured (TYPESAFE_API_KEY)" }, 503);
    const ids = repo.annotatedTraceIds(Number(c.req.query("limit") ?? 30));
    if (!ids.length) return c.json({ error: "no human-labeled traces yet; leave pass/fail verdicts on a few traces first" }, 409);
    const results: Record<string, string> = {};
    let cost = 0;
    for (const id of ids) {
      const out = await evaluateTrace(repo, judges, e, id, { force: true });
      results[id] = out.status;
      cost += out.costUsd ?? 0;
    }
    const diagnostics = questionDiagnostics(repo.questionScoreRows({ evaluator: e.name, traceIds: ids }), { minLabeled: 4 });
    return c.json({ evaluator: e.name, traces: ids.length, results, costUsd: cost, diagnostics });
  });
  app.post("/api/v1/evaluators", async (c) => {
    const p = evaluatorBody.safeParse(await c.req.json());
    if (!p.success) return c.json({ error: p.error.message }, 400);
    const existing = repo.getEvaluatorByName(p.data.name);
    if (existing?.builtin) return c.json({ error: "cannot overwrite a builtin evaluator; create one with a different name or toggle it via PATCH" }, 409);
    const kind = p.data.kind ?? (p.data.checks ? "code" : "jev");
    const questions = kind === "code" ? { checks: p.data.checks ?? [] } : (p.data.questions ?? {});
    if (kind === "code" && !p.data.checks?.length) return c.json({ error: "code evaluators need a non-empty `checks` array" }, 400);
    if (kind === "jev" && !Object.keys(questions).length) return c.json({ error: "jev evaluators need at least one question" }, 400);
    const findings = lintEvaluator({ kind, target: p.data.target ?? "trace", filter: p.data.filter ?? null, questions, composite: p.data.composite ?? null });
    // errors are real breakage (unknown question in composite, wrong transform, ...); ?force=1 saves anyway
    if (hasErrors(findings) && c.req.query("force") !== "1") return c.json({ error: "evaluator failed lint; fix the errors or pass ?force=1", lint: findings }, 422);
    const { checks: _c, ...rest } = p.data;
    return c.json({ ...repo.upsertEvaluator({ ...rest, kind, questions, filter: p.data.filter ?? null, composite: p.data.composite ?? null }), lint: findings }, 201);
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
      schedule(p.data.traceId);
    }
    return c.json({ ok: true }, 201);
  });
  app.get("/api/v1/datasets/:name/runs", (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json({ data: repo.listRuns(d.id as string) });
  });
  /** Run report: pass@1, pass@k, pass^k, per-item pass rates (suspect_broken = 0/k), optional regression diff vs ?compare=<run>. ?pass=<scoreName> picks the pass score (default `passed`). */
  app.get("/api/v1/datasets/:name/runs/:run", (c) => {
    const d = repo.getDatasetByName(c.req.param("name"));
    if (!d) return c.json({ error: "not found" }, 404);
    const passScore = c.req.query("pass") ?? "passed";
    const report = runReport(c.req.param("run"), repo.runTrials(d.id as string, c.req.param("run")), passScore);
    const cmp = c.req.query("compare");
    const diff = cmp ? compareRuns(runReport(cmp, repo.runTrials(d.id as string, cmp), passScore), report) : undefined;
    return c.json({ ...report, ...(diff ? { compare: { base: cmp, ...diff } } : {}) });
  });

  /** Grader calibration: agreement between EVAL scores and human ANNOTATION scores of the same name on the same trace. */
  app.get("/api/v1/calibration", (c) => c.json({ data: calibration(repo.calibrationPairs()) }));
  /** Per-question diagnostics: undecided/low-confidence rates, constancy, separation vs the human verdict, and what to rewrite. ?evaluator=<name> */
  app.get("/api/v1/calibration/questions", (c) => c.json({ data: questionDiagnostics(repo.questionScoreRows({ evaluator: c.req.query("evaluator") || undefined })) }));

  /** Traces worth a human look: low confidence, failed, grader errors. */
  app.get("/api/v1/review", (c) => c.json({ data: repo.reviewQueue(Number(c.req.query("limit") ?? 100)) }));

  return app;
}
