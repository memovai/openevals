import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import type { Hono } from "hono";
import type { Judge } from "../src/eval/jev.js";
import type { Escalator } from "../src/eval/escalate.js";
import { schemaFor, toJevAnswers, renderQuestions } from "../src/eval/escalate.js";
import { buildObservationState } from "../src/eval/state.js";
import type { Questions } from "@typesafe-ai/sdk";

/** jev stand-in whose confidence we can dial. */
function fakeJudge(conf: number, noul = 0.9): Judge & { calls: number } {
  return {
    model: "jev-fake",
    calls: 0,
    async judge(_state, questions: Questions) {
      this.calls++;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul };
        else if (q.type === "score") {
          const n = q.criteria.length;
          answers[id] = { type: "score", score: n - 1, confidence: conf, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === n - 1 ? conf : (1 - conf) / (n - 1)])) };
        } else {
          const keys = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: keys[0], confidence: conf, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? conf : (1 - conf) / (keys.length - 1)])) };
        }
      }
      return { model: "jev-fake", answers: answers as never, usage: { input_tokens: 500, output_tokens: 0 }, latencyMs: 3 };
    },
  };
}

function fakeEscalator(): Escalator & { calls: number } {
  return {
    model: "claude-fake",
    calls: 0,
    async escalate(_state, questions: Questions) {
      this.calls++;
      const parsed: Record<string, Record<string, unknown>> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") parsed[id] = { rationale: `because ${id}`, probability_yes: 0.1 };
        else if (q.type === "score") parsed[id] = { rationale: `because ${id}`, level: 0 };
        else parsed[id] = { rationale: `because ${id}`, choice: Object.keys(q.criteria).at(-1) };
      }
      const { answers, rationales } = toJevAnswers(parsed, questions);
      return { model: "claude-fake", answers, rationales, usage: { input_tokens: 3000, output_tokens: 400 }, costUsd: 0.025, latencyMs: 900 };
    },
  };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const batch = {
  batch: [
    { id: "1", type: "trace-create", timestamp: "2026-09-18T00:00:00Z", body: { id: "t1", name: "agent", input: "find the price", output: "$12" } },
    { id: "2", type: "tool-create", timestamp: "2026-09-18T00:00:00Z", body: { id: "s1", traceId: "t1", name: "search", input: { q: "price" }, output: "12 USD", startTime: "2026-09-18T00:00:00Z", endTime: "2026-09-18T00:00:01Z" } },
    { id: "3", type: "tool-create", timestamp: "2026-09-18T00:00:01Z", body: { id: "s2", traceId: "t1", name: "search", input: { q: "price" }, output: { error: "429" }, level: "ERROR", startTime: "2026-09-18T00:00:01Z", endTime: "2026-09-18T00:00:02Z" } },
    { id: "4", type: "generation-create", timestamp: "2026-09-18T00:00:02Z", body: { id: "g1", traceId: "t1", name: "answer", output: "$12", startTime: "2026-09-18T00:00:02Z" } },
  ],
};

describe("observation-level evaluators", () => {
  it("builds a focused per-step state with prior context", () => {
    const { app, repo } = createApp({ dbPath: ":memory:", judge: fakeJudge(0.9), quiet: true });
    void app;
    // seed directly
    repo.upsertTrace({ id: "t", input: "task", output: "out", timestamp: "2026-09-18T00:00:00Z" });
    repo.upsertObservation({ id: "a", trace_id: "t", type: "AGENT", name: "root", start_time: "2026-09-18T00:00:00Z" });
    repo.upsertObservation({ id: "b", trace_id: "t", parent_observation_id: "a", type: "TOOL", name: "search", input: { q: 1 }, output: "x".repeat(50_000), start_time: "2026-09-18T00:00:01Z" });
    const obs = repo.listObservations("t");
    const { state, meta } = buildObservationState(repo.getTrace("t")!, obs, obs[1]!, 10_000);
    expect(state.step.name).toBe("search");
    expect(state.context.parent).toBe("root");
    expect(state.context.position).toBe("step 2 of 2");
    expect(state.context.previous_steps).toEqual([{ i: 0, type: "AGENT", name: "root" }]);
    expect(meta.truncated).toBe(true);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(10_000);
  });

  it("judges each matching observation, attaches scores to it, caches per step", async () => {
    const judge = fakeJudge(0.9);
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, quiet: true });
    // enable the shipped-disabled tool_call evaluator, disable the trace-level ones to isolate
    for (const e of repo.listEvaluators()) repo.setEvaluatorEnabled(e.id, e.name === "tool_call");
    expect((await post(app, "/api/public/ingestion", batch)).status).toBe(207);
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01'");
    await worker!.tick();
    expect(judge.calls).toBe(2); // two TOOL observations, not the GENERATION
    const scores = repo.listScores("t1").filter((s) => s.source === "EVAL");
    expect(new Set(scores.map((s) => s.observation_id))).toEqual(new Set(["s1", "s2"]));
    expect(scores.filter((s) => s.name === "tool_call_quality")).toHaveLength(2);
    const jd = repo.listJudgments("t1");
    expect(jd.map((j) => j.observation_id).sort()).toEqual(["s1", "s2"]);
    // re-run: cached per observation
    const out = await evaluateAll(app, "t1");
    expect(out.tool_call?.status).toBe("cached");
    expect(judge.calls).toBe(2);
    // UI shows per-step badges
    const html = await (await app.request("/traces/t1")).text();
    expect(html).toContain("tool_call_quality");
    expect(html).toContain("@ search");
  });

  it("custom observation evaluator via REST honours observationNames", async () => {
    const judge = fakeJudge(0.9);
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    await post(app, "/api/public/ingestion", batch);
    const res = await post(app, "/api/v1/evaluators", {
      name: "gen-check",
      target: "observation",
      filter: { observationTypes: ["GENERATION"], observationNames: ["answer"] },
      questions: { terse: { type: "noul", instructions: "Is `step.output` under one sentence?" } },
    });
    expect(res.status).toBe(201);
    const out = (await (await app.request("/api/v1/traces/t1/evaluate?evaluator=gen-check", { method: "POST" })).json()) as { results: Record<string, { status: string; items: Record<string, unknown> }> };
    expect(Object.keys(out.results["gen-check"]!.items)).toEqual(["g1"]);
    expect(repo.listScores("t1").find((s) => s.name === "terse")?.observation_id).toBe("g1");
  });
});

async function evaluateAll(app: Hono, id: string) {
  return (await (await app.request(`/api/v1/traces/${id}/evaluate`, { method: "POST" })).json() as { results: Record<string, { status: string }> }).results;
}

describe("escalation", () => {
  it("builds a strict schema and renders questions", () => {
    const qs: Questions = {
      a: { type: "noul", instructions: "x?" },
      b: { type: "score", instructions: "y?", criteria: ["lo", "mid", "hi"] },
      c: { type: "choice", instructions: "z?", criteria: { p: "P", q: "Q" } },
    };
    const schema = schemaFor(qs);
    expect(schema.safeParse({ a: { rationale: "", probability_yes: 0.3 }, b: { rationale: "", level: 2 }, c: { rationale: "", choice: "q" } }).success).toBe(true);
    expect(schema.safeParse({ a: { rationale: "", probability_yes: 1.3 }, b: { rationale: "", level: 2 }, c: { rationale: "", choice: "q" } }).success).toBe(false);
    expect(schema.safeParse({ a: { rationale: "", probability_yes: 0.3 }, b: { rationale: "", level: 3 }, c: { rationale: "", choice: "q" } }).success).toBe(false);
    expect(schema.safeParse({ a: { rationale: "", probability_yes: 0.3 }, b: { rationale: "", level: 2 }, c: { rationale: "", choice: "zz" } }).success).toBe(false);
    const text = renderQuestions(qs);
    expect(text).toContain("level 2: hi");
    expect(text).toContain("q: Q");
    const { answers } = toJevAnswers({ a: { rationale: "r", probability_yes: 0.3 }, b: { rationale: "r", level: 2 }, c: { rationale: "r", choice: "q" } }, qs);
    expect(answers.b).toMatchObject({ type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } });
    expect(answers.c).toMatchObject({ type: "choice", choice: "q" });
  });

  it("does not escalate confident judgments", async () => {
    const judge = fakeJudge(0.95);
    const esc = fakeEscalator();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, escalator: esc, quiet: true });
    await post(app, "/api/public/ingestion", batch);
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01'");
    await worker!.tick();
    expect(esc.calls).toBe(0);
    expect(repo.listJudgments("t1").every((j) => !j.needs_review)).toBe(true);
    expect(repo.listJudgments("t1").some((j) => j.model === "code")).toBe(true); // sanity ran for free
  });

  it("escalates low-confidence judgments, replaces scores with rationales, keeps audit chain", async () => {
    const judge = fakeJudge(0.3);
    const esc = fakeEscalator();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, escalator: esc, quiet: true });
    await post(app, "/api/public/ingestion", batch);
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01'");
    await worker!.tick();
    expect(esc.calls).toBe(1); // only `trajectory` ran (no expected output, tool_call disabled)
    const jds = repo.listJudgments("t1").filter((j) => j.model !== "code");
    expect(jds).toHaveLength(2);
    const escalated = jds.find((j) => j.escalated_from)!;
    const original = jds.find((j) => !j.escalated_from)!;
    expect(escalated.escalated_from).toBe(original.id);
    expect(escalated.model).toBe("claude-fake");
    expect(escalated.rationales?.task_completion).toBe("because task_completion");
    expect(original.needs_review).toBe(false); // cleared once the second opinion landed
    const scores = repo.listScores("t1").filter((s) => s.source === "EVAL" && s.metadata?.model !== "code");
    // scores now come from the escalation: level 0 → task_completion 0, choice = last option
    expect(scores.find((s) => s.name === "task_completion")?.value).toBe(0);
    expect(scores.find((s) => s.name === "task_completion")?.comment).toBe("because task_completion");
    expect(scores.find((s) => s.name === "failure_mode")?.string_value).toBe("cannot_determine"); // fake escalator picks the last option
    expect(scores.find((s) => s.name === "passed")?.value).toBe(0);
    expect(scores.every((s) => s.metadata?.escalated === true)).toBe(true);
    expect(scores.every((s) => s.judgment_id === escalated.id)).toBe(true);
    const html = await (await app.request("/traces/t1")).text();
    expect(html).toContain("escalated");
    expect(html).toContain("because task_completion");
  });

  it("escalates on an undecided noul even when confidence is fine", async () => {
    const judge = fakeJudge(0.95, 0.52);
    const esc = fakeEscalator();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, escalator: esc, quiet: true });
    await post(app, "/api/public/ingestion", batch);
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01'");
    await worker!.tick();
    expect(esc.calls).toBe(1);
  });

  it("manual escalation endpoint", async () => {
    const judge = fakeJudge(0.95);
    const esc = fakeEscalator();
    const { app, repo } = createApp({ dbPath: ":memory:", judge, escalator: esc, quiet: true });
    await post(app, "/api/public/ingestion", batch);
    await evaluateAll(app, "t1");
    expect(esc.calls).toBe(0);
    const res = await app.request("/api/v1/traces/t1/escalate", { method: "POST" });
    const out = (await res.json()) as { results: Record<string, { status: string; escalated: boolean }> };
    expect(out.results.trajectory).toMatchObject({ status: "judged", escalated: true });
    expect(esc.calls).toBe(1);
    expect(repo.listJudgments("t1").filter((j) => j.escalated_from)).toHaveLength(1);
    // without an escalator configured → 503
    const { app: app2 } = createApp({ dbPath: ":memory:", judge, escalator: null, quiet: true });
    expect((await app2.request("/api/v1/traces/t1/escalate", { method: "POST" })).status).toBe(404); // no trace in fresh db
    await post(app2, "/api/public/ingestion", batch);
    expect((await app2.request("/api/v1/traces/t1/escalate", { method: "POST" })).status).toBe(503);
  });
});
