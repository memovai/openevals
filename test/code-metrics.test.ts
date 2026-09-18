import { describe, it, expect } from "vitest";
import { runCodeChecks } from "../src/eval/code.js";
import { runReport, compareRuns, calibration } from "../src/eval/metrics.js";
import { createApp } from "../src/server.js";
import type { ObservationRow, TraceRow, ScoreRow } from "../src/db/repo.js";
import type { Judge } from "../src/eval/jev.js";

const now = "2026-09-18T00:00:00.000Z";
const trace = (over: Partial<TraceRow> = {}): TraceRow => ({
  id: "t1", project_id: "default", name: "agent", user_id: null, session_id: null, input: "q", output: "The answer is 42.", expected_output: "42",
  metadata: null, tags: null, release: null, version: null, environment: null, timestamp: now, created_at: now, updated_at: now, ...over,
});
const obs = (i: number, over: Partial<ObservationRow> = {}): ObservationRow => ({
  id: `o${i}`, trace_id: "t1", parent_observation_id: null, type: "TOOL", name: "search", start_time: now, end_time: "2026-09-18T00:00:02.000Z",
  completion_start_time: null, input: { q: "x" }, output: "r", metadata: null, level: "DEFAULT", status_message: null, model: null,
  model_parameters: null, usage_input: null, usage_output: null, usage_total: 100, cost_usd: 0.01, created_at: now, updated_at: now, ...over,
});

describe("code graders", () => {
  it("runs deterministic checks and reports measured values", () => {
    const o = [obs(0), obs(1), obs(2, { input: { q: "y" } }), obs(3, { type: "GENERATION", name: "llm", level: "ERROR" })];
    const { results, features } = runCodeChecks(trace(), o, [
      { type: "output_nonempty" },
      { type: "output_contains_expected" },
      { type: "output_equals_expected" },
      { type: "output_regex", pattern: "\\d+" },
      { type: "max_steps", value: 3 },
      { type: "max_tool_calls", value: 5 },
      { type: "max_total_tokens", value: 350 },
      { type: "no_errors" },
      { type: "no_unresolved_error" },
      { type: "required_tools", tools: ["search", "book"] },
      { type: "forbidden_tools", tools: ["delete"] },
      { name: "storm", type: "max_repeated_tool_call", value: 1 },
      { type: "max_cost_usd", value: 1 },
    ]);
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(by.output_nonempty!.passed).toBe(true);
    expect(by.output_contains_expected!.passed).toBe(true);
    expect(by.output_equals_expected!.passed).toBe(false);
    expect(by.output_regex!.passed).toBe(true);
    expect(by.max_steps!.passed).toBe(false);
    expect(by.max_steps!.value).toBe(4);
    expect(by.max_tool_calls!.passed).toBe(true);
    expect(by.max_total_tokens!.passed).toBe(false); // 400
    expect(by.no_errors!.passed).toBe(false);
    expect(by.no_unresolved_error!.passed).toBe(false); // last step is ERROR
    expect(by.required_tools!.passed).toBe(false);
    expect(by.required_tools!.detail).toContain("book");
    expect(by.forbidden_tools!.passed).toBe(true);
    expect(by.storm!.passed).toBe(false); // search called 2x with identical input
    expect(by.storm!.value).toBe(2);
    expect(by.max_cost_usd!.passed).toBe(true);
    expect(features.tools_called).toEqual(["search", "search", "search"]);
  });
  it("fails expected-output checks gracefully without a reference", () => {
    const { results } = runCodeChecks(trace({ expected_output: null }), [], [{ type: "output_equals_expected" }]);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.detail).toContain("no expected_output");
  });
});

const passScore = (traceId: string, v: number, name = "passed"): ScoreRow => ({ id: `${traceId}-${name}`, trace_id: traceId, observation_id: null, name, value: v, string_value: null, data_type: "BOOLEAN", source: "EVAL", comment: null, metadata: null, evaluator_id: "e", judgment_id: "j", timestamp: now });
const qScore = (traceId: string, v: number): ScoreRow => ({ ...passScore(traceId, v, "trajectory_quality"), data_type: "NUMERIC" });

describe("pass@k / pass^k", () => {
  it("computes per-trial, any-of-k and all-of-k", () => {
    const trials = [
      // item A: 3 trials, 2 pass
      { dataset_item_id: "A", trace_id: "a1", scores: [passScore("a1", 1), qScore("a1", 0.9)] },
      { dataset_item_id: "A", trace_id: "a2", scores: [passScore("a2", 1), qScore("a2", 0.8)] },
      { dataset_item_id: "A", trace_id: "a3", scores: [passScore("a3", 0), qScore("a3", 0.2)] },
      // item B: 3 trials, all pass
      { dataset_item_id: "B", trace_id: "b1", scores: [passScore("b1", 1)] },
      { dataset_item_id: "B", trace_id: "b2", scores: [passScore("b2", 1)] },
      { dataset_item_id: "B", trace_id: "b3", scores: [passScore("b3", 1)] },
      // item C: 3 trials, none pass → suspect broken
      { dataset_item_id: "C", trace_id: "c1", scores: [passScore("c1", 0)] },
      { dataset_item_id: "C", trace_id: "c2", scores: [passScore("c2", 0)] },
      { dataset_item_id: "C", trace_id: "c3", scores: [passScore("c3", 0)] },
      // item D: not graded yet → excluded from rates
      { dataset_item_id: "D", trace_id: "d1", scores: [] },
    ];
    const r = runReport("v1", trials);
    expect(r.items).toBe(4);
    expect(r.k).toBe(3);
    expect(r.pass_at_1).toBeCloseTo((2 / 3 + 1 + 0) / 3, 6);
    expect(r.pass_at_k).toBeCloseTo(2 / 3, 6);
    expect(r.pass_pow_k).toBeCloseTo(1 / 3, 6);
    expect(r.per_item.find((i) => i.item_id === "C")!.suspect_broken).toBe(true);
    expect(r.per_item.find((i) => i.item_id === "A")!.suspect_broken).toBe(false);
    expect(r.per_item.find((i) => i.item_id === "D")!.pass_rate).toBeNull();
    expect(r.avg.trajectory_quality).toBeCloseTo((0.9 + 0.8 + 0.2) / 3, 6);
    expect(r.per_item[0]!.item_id).toBe("C"); // worst first
  });
  it("requires all pass-type scores on a trace to be true", () => {
    const r = runReport("v1", [{ dataset_item_id: "A", trace_id: "a1", scores: [passScore("a1", 1), { ...passScore("a1", 0), id: "x", evaluator_id: "sanity" }] }]);
    expect(r.pass_at_1).toBe(0);
  });
  it("detects regressions and fixes between runs", () => {
    const base = runReport("v1", [
      { dataset_item_id: "A", trace_id: "a", scores: [passScore("a", 1)] },
      { dataset_item_id: "B", trace_id: "b", scores: [passScore("b", 0)] },
      { dataset_item_id: "C", trace_id: "c", scores: [passScore("c", 1)] },
    ]);
    const cand = runReport("v2", [
      { dataset_item_id: "A", trace_id: "a2", scores: [passScore("a2", 0)] },
      { dataset_item_id: "B", trace_id: "b2", scores: [passScore("b2", 1)] },
      { dataset_item_id: "C", trace_id: "c2", scores: [passScore("c2", 1)] },
      { dataset_item_id: "E", trace_id: "e2", scores: [passScore("e2", 1)] },
    ]);
    expect(compareRuns(base, cand)).toEqual({ regressions: ["A"], fixes: ["B"], unchanged: 1, only_in_base: [], only_in_candidate: ["E"] });
  });
});

describe("calibration", () => {
  it("computes agreement, kappa, false pass/fail, MAE, r", () => {
    const pairs = [
      { trace_id: "1", name: "passed", eval_value: 1, eval_str: null, human_value: 1, human_str: null, data_type: "BOOLEAN" },
      { trace_id: "2", name: "passed", eval_value: 1, eval_str: null, human_value: 0, human_str: null, data_type: "BOOLEAN" }, // false pass
      { trace_id: "3", name: "passed", eval_value: 0, eval_str: null, human_value: 0, human_str: null, data_type: "BOOLEAN" },
      { trace_id: "4", name: "passed", eval_value: 0, eval_str: null, human_value: 0, human_str: null, data_type: "BOOLEAN" },
      { trace_id: "1", name: "grounded_in_evidence", eval_value: 0.9, eval_str: null, human_value: 1, human_str: null, data_type: "NUMERIC" },
      { trace_id: "2", name: "grounded_in_evidence", eval_value: 0.3, eval_str: null, human_value: 0, human_str: null, data_type: "NUMERIC" },
      { trace_id: "1", name: "failure_mode", eval_value: null, eval_str: "none", human_value: null, human_str: "none", data_type: "CATEGORICAL" },
      { trace_id: "2", name: "failure_mode", eval_value: null, eval_str: "stuck_in_loop", human_value: null, human_str: "gave_up_early", data_type: "CATEGORICAL" },
    ];
    const rows = calibration(pairs);
    const passed = rows.find((r) => r.name === "passed")!;
    expect(passed.n).toBe(4);
    expect(passed.agreement).toBe(0.75);
    expect(passed.false_pass).toBe(1);
    expect(passed.false_fail).toBe(0);
    expect(passed.kappa).toBeCloseTo(0.5, 6);
    const g = rows.find((r) => r.name === "grounded_in_evidence")!;
    expect(g.agreement).toBe(1); // thresholded at 0.5 agrees with the boolean human
    expect(g.mae).toBeCloseTo(0.2, 6);
    expect(g.pearson_r).toBeCloseTo(1, 6);
    const fm = rows.find((r) => r.name === "failure_mode")!;
    expect(fm.agreement).toBe(0.5);
  });
});

describe("end to end: code grader + dataset run + review + annotate", () => {
  const judge: Judge = { model: "fake", judge: async () => ({ model: "fake", answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0 }) };
  const post = (app: { request: (p: string, i?: RequestInit) => Promise<Response> | Response }, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("code graders run through the worker even with no jev key", async () => {
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge: null, quiet: true });
    expect(worker).not.toBeNull();
    await post(app, "/api/public/ingestion", { batch: [{ type: "trace-create", timestamp: now, body: { id: "t0", name: "a", input: "q", output: "fine" } }] });
    expect(repo.queueStats()).toEqual({ pending: 1 }); // only sanity was scheduled
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01'");
    await worker!.tick();
    expect(repo.listScores("t0").find((s) => s.name === "sanity_passed")?.value).toBe(1);
    const out = (await (await app.request("/api/v1/traces/t0/evaluate?evaluator=trajectory", { method: "POST" })).json()) as { results: Record<string, { status: string; reason?: string }> };
    expect(out.results.trajectory?.status).toBe("skipped");
    expect(out.results.trajectory?.reason).toContain("no judge");
  });

  it("sanity runs for free and a custom code evaluator can be created", async () => {
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    for (const e of repo.listEvaluators()) repo.setEvaluatorEnabled(e.id, e.kind === "code");
    await post(app, "/api/public/ingestion", {
      batch: [
        { type: "trace-create", timestamp: now, body: { id: "t1", name: "a", input: "q", output: "" } },
        { type: "tool-create", timestamp: now, body: { id: "s1", traceId: "t1", name: "search", startTime: now, level: "ERROR" } },
      ],
    });
    const out = (await (await app.request("/api/v1/traces/t1/evaluate", { method: "POST" })).json()) as { results: Record<string, { status: string; costUsd: number }> };
    expect(out.results.sanity).toMatchObject({ status: "judged", costUsd: 0 });
    const scores = repo.listScores("t1");
    expect(scores.find((s) => s.name === "output_nonempty")?.value).toBe(0);
    expect(scores.find((s) => s.name === "no_unresolved_error")?.value).toBe(0);
    expect(scores.find((s) => s.name === "sanity_passed")?.value).toBe(0);
    expect(scores.find((s) => s.name === "sanity_score")?.value).toBe(0.5);
    // custom code evaluator via REST
    const res = await post(app, "/api/v1/evaluators", { name: "limits", checks: [{ type: "max_steps", value: 1 }, { type: "required_tools", tools: ["search"] }] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { kind: string }).kind).toBe("code");
    const out2 = (await (await app.request("/api/v1/traces/t1/evaluate?evaluator=limits", { method: "POST" })).json()) as { results: Record<string, { status: string }> };
    expect(out2.results.limits?.status).toBe("judged");
    expect(repo.listScores("t1").find((s) => s.name === "required_tools")?.value).toBe(1);
    expect(repo.listScores("t1").find((s) => s.name === "passed" && s.evaluator_id)?.value).toBe(1); // limits' pass score
    // bad: code evaluator without checks
    expect((await post(app, "/api/v1/evaluators", { name: "empty", kind: "code" })).status).toBe(400);
  });

  it("dataset run report with two trials, review queue, human annotation and calibration", async () => {
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    for (const e of repo.listEvaluators()) repo.setEvaluatorEnabled(e.id, e.name === "sanity");
    await post(app, "/api/v1/datasets", { name: "smoke" });
    const ids = ((await (await post(app, "/api/v1/datasets/smoke/items", { items: [{ id: "i1", input: "q1", expectedOutput: "42" }, { id: "i2", input: "q2", expectedOutput: "7" }] })).json()) as { ids: string[] }).ids;
    expect(ids).toEqual(["i1", "i2"]);
    // 2 trials per item; i2 trial 2 fails sanity (empty output)
    const traces: [string, string, string][] = [["a1", "i1", "42"], ["a2", "i1", "42"], ["b1", "i2", "7"], ["b2", "i2", ""]];
    for (const [tid, item, out] of traces) {
      await post(app, "/api/public/ingestion", { batch: [{ type: "trace-create", timestamp: now, body: { id: tid, name: "agent", input: "q", output: out } }] });
      await post(app, "/api/v1/datasets/smoke/runs/v1/items", { datasetItemId: item, traceId: tid });
      await app.request(`/api/v1/traces/${tid}/evaluate`, { method: "POST" });
    }
    expect(repo.getTrace("a1")!.expected_output).toBe("42"); // copied from the item
    const rep = (await (await app.request("/api/v1/datasets/smoke/runs/v1?pass=sanity_passed")).json()) as { pass_at_1: number; pass_at_k: number; pass_pow_k: number; k: number; per_item: { item_id: string; passes: number }[] };
    expect(rep.k).toBe(2);
    expect(rep.pass_at_1).toBeCloseTo(0.75, 6);
    expect(rep.pass_at_k).toBe(1);
    expect(rep.pass_pow_k).toBe(0.5);
    // review queue lists the failed trace (sanity_passed isn't `passed`, so annotate-driven path: use default pass name → nothing failed yet)
    // human annotates b2 as fail and a1 as pass via the UI form
    let r = await app.request("/traces/b2/annotate", { method: "POST", body: new URLSearchParams({ verdict: "0", comment: "empty answer" }) });
    expect(r.status).toBe(302);
    r = await app.request("/traces/a1/annotate", { method: "POST", body: new URLSearchParams({ verdict: "1" }) });
    expect(repo.listScores("b2").find((s) => s.source === "ANNOTATION")).toMatchObject({ name: "passed", value: 0, comment: "empty answer" });
    const review = (await (await app.request("/api/v1/review")).json()) as { data: { trace: { id: string }; reasons: string[] }[] };
    expect(review.data.map((d) => d.trace.id)).toContain("b2");
    // calibration: sanity's pass score is `sanity_passed`, so create a grader `passed` to compare — via a code evaluator with passName passed
    await post(app, "/api/v1/evaluators", { name: "gate", checks: [{ type: "output_nonempty" }], composite: { name: "gate", terms: [], passName: "passed" } });
    for (const t of ["a1", "b2"]) await app.request(`/api/v1/traces/${t}/evaluate?evaluator=gate`, { method: "POST" });
    const cal = (await (await app.request("/api/v1/calibration")).json()) as { data: { name: string; n: number; agreement: number; false_pass: number }[] };
    const passed = cal.data.find((c) => c.name === "passed")!;
    expect(passed.n).toBe(2);
    expect(passed.agreement).toBe(1);
    expect(passed.false_pass).toBe(0);
    // pages render
    for (const p of ["/review", "/calibration", "/datasets", "/traces/b2"]) expect((await app.request(p)).status).toBe(200);
    expect(await (await app.request("/datasets")).text()).toContain("pass^k");
  });
});
