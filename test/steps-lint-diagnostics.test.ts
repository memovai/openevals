import { describe, it, expect } from "vitest";
import type { Hono } from "hono";
import type { Questions } from "@typesafe-ai/sdk";
import { createApp } from "../src/server.js";
import type { Judge } from "../src/eval/jev.js";
import type { Compiler, CompiledEvaluator } from "../src/eval/compile.js";
import { compileRubric } from "../src/eval/compile.js";
import { summarizeSteps, sampleEvenly, mapLimit, stepJudgmentsFromScores } from "../src/eval/steps.js";
import { buildTraceState, buildObservationState } from "../src/eval/state.js";
import { lintEvaluator, hasErrors } from "../src/eval/lint.js";
import { questionDiagnostics, auc } from "../src/eval/diagnostics.js";
import { builtinEvaluators } from "../src/eval/builtin.js";
import { templates } from "../src/eval/templates.js";
import type { ObservationRow, ScoreRow, TraceRow } from "../src/db/repo.js";

const now = "2026-09-18T00:00:00.000Z";
const trace = (over: Partial<TraceRow> = {}): TraceRow => ({
  id: "t1", project_id: "default", name: "agent", user_id: null, session_id: null, input: "do the thing", output: "done", expected_output: null,
  metadata: null, tags: null, release: null, version: null, environment: null, timestamp: now, created_at: now, updated_at: now, ...over,
});
const obs = (i: number, over: Partial<ObservationRow> = {}): ObservationRow => ({
  id: `o${i}`, trace_id: "t1", parent_observation_id: null, type: "TOOL", name: `tool${i}`, start_time: now, end_time: "2026-09-18T00:00:01.000Z",
  completion_start_time: null, input: { q: i }, output: "x".repeat(200), metadata: null, level: "DEFAULT", status_message: null, model: null,
  model_parameters: null, usage_input: null, usage_output: null, usage_total: 10, cost_usd: null, created_at: now, updated_at: now, ...over,
});
const score = (obsId: string | null, name: string, value: number | null, extra: Partial<ScoreRow> = {}): ScoreRow => ({
  id: `${obsId}-${name}`, trace_id: "t1", observation_id: obsId, name, value, string_value: null, data_type: "NUMERIC", source: "EVAL", comment: null,
  metadata: { kind: name === "progress" ? "score" : name === "step_quality" ? "composite" : "noul", ...(name === "progress" ? { legend: { "0": "a", "1": "b", "2": "c" } } : {}) },
  evaluator_id: "ev", judgment_id: "jd", timestamp: now, ...extra,
});

describe("per-step roll-up", () => {
  // 6 steps: progress 2,1,1,ERR(0),2,2 ; step 2 off task ; step 4 redundant
  const o = [obs(0), obs(1), obs(2), obs(3, { level: "ERROR" }), obs(4), obs(5)];
  const scores: ScoreRow[] = [
    score("o0", "progress", 2), score("o0", "on_task", 0.95), score("o0", "redundant", 0.05), score("o0", "step_quality", 0.9),
    score("o1", "progress", 1), score("o1", "on_task", 0.9), score("o1", "redundant", 0.1), score("o1", "step_quality", 0.5),
    score("o2", "progress", 1.2), score("o2", "on_task", 0.2), score("o2", "redundant", 0.1), score("o2", "step_quality", 0.4),
    score("o3", "progress", 0), score("o3", "on_task", 0.9), score("o3", "redundant", 0.2), score("o3", "step_quality", 0.2),
    score("o4", "progress", 2), score("o4", "on_task", 0.9), score("o4", "redundant", 0.8), score("o4", "step_quality", 0.6),
    score("o5", "progress", 1.9), score("o5", "on_task", 0.9), score("o5", "redundant", 0.1), score("o5", "step_quality", 0.9),
  ];
  it("computes credit-assignment metrics", () => {
    const s = summarizeSteps(o, scores);
    expect(s.steps_judged).toBe(6);
    expect(s.progress_mean).toBeCloseTo((2 + 1 + 1.2 + 0 + 2 + 1.9) / 2 / 6, 5);
    expect(s.no_progress_steps).toBe(3); // o1, o2, o3
    expect(s.longest_stall).toBe(3); // o1..o3
    expect(s.wasted_steps).toBe(4); // o1,o2,o3 no progress + o4 redundant
    expect(s.wasted_fraction).toBeCloseTo(4 / 6, 5);
    expect(s.off_task_steps).toBe(1);
    expect(s.first_off_task_step).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.errors_recovered).toBe(1);
    expect(s.error_recovery_rate).toBe(1);
    expect(s.mean_steps_to_recover).toBe(1); // o3 → o4
    expect(s.composites.step_quality_mean).toBeCloseTo((0.9 + 0.5 + 0.4 + 0.2 + 0.6 + 0.9) / 6, 5);
  });
  it("leaves metrics null when the conventional questions are absent", () => {
    const s = summarizeSteps(o, [score("o0", "step_quality", 0.5)]);
    expect(s.steps_judged).toBe(1);
    expect(s.progress_mean).toBeNull();
    expect(s.wasted_fraction).toBeNull();
    expect(s.first_off_task_step).toBeNull();
    expect(s.composites.step_quality_mean).toBe(0.5);
  });
  it("folds per-step answers into the trace-level state and keeps a digest of elided steps", () => {
    const judgments = stepJudgmentsFromScores(scores);
    expect(judgments.get("o2")).toEqual({ progress: 1.2, on_task: 0.2, redundant: 0.1, step_quality: 0.4 });
    const big = Array.from({ length: 60 }, (_, i) => obs(i, { output: "y".repeat(400) }));
    const j = new Map(big.map((x, i) => [x.id, { progress: i % 3, on_task: 0.9 }]));
    const { state, meta } = buildTraceState(trace(), big, 12_000, { stepJudgments: j, stepSummary: { steps_judged: 60, progress_mean: 0.33 } });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(12_000);
    expect(meta.steps_judged).toBe(60);
    expect(meta.steps_digested).toBeGreaterThan(0);
    expect(state.trajectory).toHaveLength(60); // nothing dropped: middle steps are digests
    const digests = state.trajectory.filter((s) => "elided" in s);
    expect(digests.length).toBe(meta.steps_digested);
    expect((digests[0] as { judgments: unknown }).judgments).toEqual({ progress: expect.any(Number), on_task: 0.9 });
    expect((state.trajectory[0] as { judgments: unknown }).judgments).toEqual({ progress: 0, on_task: 0.9 });
    expect(state.step_summary).toEqual({ steps_judged: 60, progress_mean: 0.33 });
  });
  it("per-step state carries previous steps with clipped I/O, the omitted count and the last error", () => {
    const o2 = [obs(0), obs(1, { level: "ERROR", status_message: "429" }), obs(2), obs(3, { output: "z".repeat(5000) })];
    const { state } = buildObservationState(trace(), o2, o2[3]!, 100_000, 2);
    expect(state.context.previous_steps.map((p) => p.i)).toEqual([1, 2]);
    expect(state.context.previous_steps_omitted).toBe(1);
    expect(state.context.previous_steps[0]!.output).toBe("x".repeat(200)); // fits within the 400-char cap
    expect(state.context.last_error).toEqual({ i: 1, name: "tool1", status_message: "429" });
    expect(state.step.output).toBe("z".repeat(5000));
  });
  it("samples evenly and keeps the ends; mapLimit bounds concurrency", async () => {
    expect(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    let inFlight = 0,
      peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});

describe("lint", () => {
  it("builtins and templates have no errors", () => {
    for (const e of builtinEvaluators) expect(hasErrors(lintEvaluator({ kind: e.kind, target: e.target, filter: e.filter, questions: e.questions, composite: e.composite })), e.name).toBe(false);
    for (const t of templates) expect(hasErrors(lintEvaluator({ kind: "jev", target: t.target, questions: t.questions, composite: t.composite })), t.id).toBe(false);
  });
  it("catches rubrics written for a text judge", () => {
    const f = lintEvaluator({
      target: "trace",
      questions: {
        q1: { type: "score", instructions: "Rate the overall quality of the answer from 1 to 10 and explain why.", criteria: ["bad", "good"] },
        q2: { type: "noul", instructions: "Did the agent call `step.input` correctly? Was it fast?" },
        q3: { type: "choice", instructions: "Which failure? `final_output`", criteria: { a: "x", b: "y" } },
        q4: { type: "noul", instructions: "输出是否正确？`final_output`" },
        q5: { type: "noul", instructions: "Is `expected_output` matched by `final_output`?" },
      },
      composite: { name: "q", terms: [{ q: "q1", weight: 1, transform: "noul" }, { q: "nope", weight: 1, transform: "noul" }, { q: "q3", weight: 1, transform: "choice_is" }], pass: [{ q: "q2", op: ">=", value: 5 }] },
    });
    const codes = new Set(f.map((x) => `${x.level}:${x.code}`));
    expect(codes).toContain("error:numeric_scale");
    expect(codes).toContain("warn:asks_for_text");
    expect(codes).toContain("warn:holistic");
    expect(codes).toContain("warn:thin_level");
    expect(codes).toContain("warn:multiple_questions");
    expect(codes).toContain("error:wrong_target_field");
    expect(codes).toContain("info:no_escape");
    expect(codes).toContain("warn:thin_option");
    expect(codes).toContain("warn:non_english");
    expect(codes).toContain("warn:expected_output_filter");
    expect(codes).toContain("error:composite_unknown_q");
    expect(codes).toContain("error:transform_type");
    expect(codes).toContain("error:choice_is_option");
    expect(codes).toContain("error:pass_range");
  });
  it("lints code evaluators", () => {
    const f = lintEvaluator({ kind: "code", questions: { checks: [{ type: "output_regex", pattern: "(" }, { type: "max_steps" }, { type: "bogus" }, { type: "output_contains_expected" }] } });
    const codes = f.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["bad_regex", "check_value", "unknown_check", "expected_output_filter"]));
  });
});

describe("question diagnostics", () => {
  const row = (trace_id: string, name: string, value: number, human: number | null, kind = "noul") => ({ trace_id, evaluator: "ev", name, value, string_value: null, metadata: { kind, ...(kind === "score" ? { legend: { "0": "a", "1": "b", "2": "c" }, confidence: 0.9 } : {}) }, human });
  it("computes AUC and flags vague, constant and non-separating questions", () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.5, 0.5], [0.5, 0.5])).toBe(0.5);
    const rows = [
      // good: separates cleanly
      ...[0.9, 0.95, 0.85, 0.8].map((v, i) => row(`p${i}`, "good", v, 1)),
      ...[0.1, 0.2, 0.15, 0.05].map((v, i) => row(`f${i}`, "good", v, 0)),
      // vague: everything near 0.5
      ...[0.5, 0.55, 0.45, 0.52, 0.48, 0.5, 0.5, 0.5].map((v, i) => row(`x${i}`, "vague", v, i % 2)),
      // constant: always 1 → no separation either
      ...Array.from({ length: 8 }, (_, i) => row(`c${i}`, "constant", 1, i % 2)),
    ];
    const d = questionDiagnostics(rows);
    const by = Object.fromEntries(d.map((x) => [x.question, x]));
    expect(by.good!.auc).toBe(1);
    expect(by.good!.direction).toBe("higher_is_pass");
    expect(by.good!.agreement).toBe(1);
    expect(by.good!.issues).toEqual([]);
    expect(by.vague!.undecided_rate).toBe(1);
    expect(by.vague!.issues.map((i) => i.code)).toContain("undecided");
    expect(by.constant!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["constant", "no_separation"]));
    // worst first
    expect(d[0]!.question).not.toBe("good");
  });
  it("handles choice questions", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ trace_id: `t${i}`, evaluator: "ev", name: "mode", value: null, string_value: "none", metadata: { kind: "choice", confidence: 0.9 }, human: i % 2 }));
    const d = questionDiagnostics(rows)[0]!;
    expect(d.mode).toBe("none");
    expect(d.mode_rate).toBe(1);
    expect(d.issues.map((i) => i.code)).toContain("constant");
  });
});

// ---------------- REST surface ----------------
function fakeJudge(): Judge & { calls: number } {
  return {
    model: "jev-fake",
    calls: 0,
    async judge(_state, questions: Questions) {
      this.calls++;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
        else if (q.type === "score") {
          const n = q.criteria.length;
          answers[id] = { type: "score", score: n - 1, confidence: 0.9, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === n - 1 ? 0.9 : 0.1 / (n - 1)])) };
        } else {
          const keys = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])) };
        }
      }
      return { model: "jev-fake", answers: answers as never, usage: { input_tokens: 100, output_tokens: 0 }, latencyMs: 1 };
    },
  };
}
function fakeCompiler(broken = false): Compiler & { calls: number } {
  return {
    model: "claude-fake",
    calls: 0,
    async compile(_req, feedback) {
      this.calls++;
      const ok: CompiledEvaluator = {
        description: "compiled",
        target: "trace",
        questions: {
          answered: { type: "noul", instructions: "Does `final_output` answer every part of `task`?", criteria: { true: "Every part of `task` is addressed in `final_output`.", false: "At least one part of `task` is not addressed." } },
          completeness: { type: "score", instructions: "How completely does `final_output` satisfy `task`?", criteria: ["Not at all: `final_output` ignores `task` or is empty.", "Partially: the main request is met but a stated requirement is missing.", "Fully: every stated requirement is met."] },
        },
        composite: { name: "compiled_quality", terms: [{ q: "answered", weight: 0.5, transform: "noul" }, { q: "completeness", weight: 0.5, transform: "score_norm" }], pass: [{ q: "completeness", op: ">=", value: 1.5 }], passName: "compiled_passed" },
        notes: ["code check: output under 500 chars"],
      };
      // first attempt (when `broken`) references a missing question; repaired on feedback
      const bad: CompiledEvaluator = { ...ok, composite: { ...ok.composite, terms: [...ok.composite.terms, { q: "missing", weight: 1, transform: "noul" }] } };
      return { evaluator: broken && !feedback ? bad : ok, usage: { input_tokens: 1000, output_tokens: 300 }, model: "claude-sonnet-5" };
    },
  };
}
const post = (app: Hono, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const batch = (id: string) => ({
  batch: [
    { id: "1", type: "trace-create", timestamp: now, body: { id, name: "agent", input: "find the price", output: "$12" } },
    { id: "2", type: "tool-create", timestamp: now, body: { id: `${id}-s`, traceId: id, name: "search", input: { q: "price" }, output: "12 USD", startTime: now, endTime: now } },
    { id: "3", type: "generation-create", timestamp: now, body: { id: `${id}-g`, traceId: id, name: "answer", output: "$12", startTime: now } },
  ],
});

describe("REST: lint, templates, compile, diagnostics, backtest", () => {
  it("lint endpoint and lint gate on create", async () => {
    const { app } = createApp({ dbPath: ":memory:", judge: null, quiet: true });
    const bad = { name: "bad", questions: { q: { type: "noul", instructions: "Is `final_output` ok?" } }, composite: { name: "x", terms: [{ q: "zzz", weight: 1, transform: "noul" }] } };
    const lint = (await (await post(app, "/api/v1/evaluators/lint", bad)).json()) as { ok: boolean; findings: { code: string }[] };
    expect(lint.ok).toBe(false);
    expect(lint.findings.map((f) => f.code)).toContain("composite_unknown_q");
    expect((await post(app, "/api/v1/evaluators", bad)).status).toBe(422);
    expect((await post(app, "/api/v1/evaluators?force=1", bad)).status).toBe(201);
    const good = await post(app, "/api/v1/evaluators", { name: "good", questions: { q: { type: "noul", instructions: "Is `final_output` polite?" } } });
    expect(good.status).toBe(201);
    expect(((await good.json()) as { lint: unknown[] }).lint).toBeDefined();
    const one = (await (await app.request("/api/v1/evaluators/good/lint")).json()) as { ok: boolean };
    expect(one.ok).toBe(true);
    // builtins are listed with lint attached
    const list = (await (await app.request("/api/v1/evaluators")).json()) as { data: { name: string; lint: unknown[] }[] };
    expect(list.data.find((e) => e.name === "step")?.lint).toBeDefined();
  });
  it("templates can be listed and copied", async () => {
    const { app, repo } = createApp({ dbPath: ":memory:", judge: null, quiet: true });
    const list = (await (await app.request("/api/v1/templates")).json()) as { data: { id: string }[] };
    expect(list.data.map((t) => t.id)).toContain("coding-agent");
    expect((await app.request("/api/v1/templates/coding-agent")).status).toBe(200);
    const res = await post(app, "/api/v1/evaluators/from-template", { template: "coding-agent", name: "my-coder", filter: { names: ["coder"] } });
    expect(res.status).toBe(201);
    const ev = repo.getEvaluatorByName("my-coder")!;
    expect(ev.filter).toEqual({ names: ["coder"] });
    expect(Object.keys(ev.questions)).toContain("implements_request");
    expect((await post(app, "/api/v1/evaluators/from-template", { template: "nope", name: "x" })).status).toBe(404);
  });
  it("compiles a rubric, repairs lint errors once, and saves on request", async () => {
    const compiler = fakeCompiler(true);
    const { app, repo } = createApp({ dbPath: ":memory:", judge: null, compiler, quiet: true });
    const res = await post(app, "/api/v1/evaluators/compile", { name: "compiled", rubric: "The answer must address everything asked, be complete, and be under 500 chars.", save: true });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { ok: boolean; attempts: number; notes: string[]; saved: { name: string } | null; lint: unknown[]; costUsd: number };
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
    expect(compiler.calls).toBe(2);
    expect(out.notes[0]).toMatch(/code check/);
    expect(out.saved?.name).toBe("compiled");
    expect(out.costUsd).toBeGreaterThan(0);
    expect(repo.getEvaluatorByName("compiled")?.composite).toMatchObject({ name: "compiled_quality" });
    // library function directly, no repair needed
    const direct = await compileRubric(fakeCompiler(false), { name: "x", rubric: "y" });
    expect(direct.attempts).toBe(1);
    // disabled without a compiler
    const { app: app2 } = createApp({ dbPath: ":memory:", judge: null, compiler: null, quiet: true });
    expect((await post(app2, "/api/v1/evaluators/compile", { name: "a", rubric: "b" })).status).toBe(503);
  });
  it("per-question diagnostics endpoint and backtest on labeled traces", async () => {
    const judge = fakeJudge();
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    for (const id of ["a", "b", "c", "d"]) {
      await post(app, "/api/public/ingestion", batch(id));
      await app.request(`/api/v1/traces/${id}/evaluate?evaluator=trajectory`, { method: "POST" });
      await post(app, "/api/v1/scores", { traceId: id, name: "passed", value: id < "c" });
    }
    const diag = (await (await app.request("/api/v1/calibration/questions?evaluator=trajectory")).json()) as { data: { question: string; n: number; n_labeled: number }[] };
    const tc = diag.data.find((d) => d.question === "task_completion")!;
    expect(tc.n).toBe(4);
    expect(tc.n_labeled).toBe(4);
    expect(repo.annotatedTraceIds()).toHaveLength(4);
    const before = judge.calls;
    const bt = await app.request("/api/v1/evaluators/trajectory/backtest?limit=3", { method: "POST" });
    expect(bt.status).toBe(200);
    const body = (await bt.json()) as { traces: number; results: Record<string, string>; diagnostics: { question: string; auc: number | null }[] };
    expect(body.traces).toBe(3);
    expect(Object.values(body.results).every((s) => s === "judged")).toBe(true);
    expect(judge.calls).toBe(before + 3); // force: cache bypassed
    expect(body.diagnostics.some((d) => d.question === "task_completion")).toBe(true);
    // pages render
    expect(await (await app.request("/calibration")).text()).toContain("what to rewrite");
    expect(await (await app.request("/evaluators")).text()).toContain("Templates");
  });
  it("trace page shows the per-step progress strip", async () => {
    const judge = fakeJudge();
    const { app } = createApp({ dbPath: ":memory:", judge, quiet: true });
    await post(app, "/api/public/ingestion", batch("s"));
    await app.request("/api/v1/traces/s/evaluate", { method: "POST" });
    const html = await (await app.request("/traces/s")).text();
    expect(html).toContain('class="strip"');
    expect(html).toContain("per-step: progress");
    expect(html).toContain("progress_mean");
  });
});
