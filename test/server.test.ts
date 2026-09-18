import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import type { Judge } from "../src/eval/jev.js";
import type { Questions } from "@typesafe-ai/sdk";

/** Fake jev: answers every question with a fixed, well-formed response. */
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
          const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
          const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === n - 1 ? 0.9 : 0.1 / (n - 1)]));
          answers[id] = { type: "score", score: n - 1.1, confidence: 0.88, legend, probabilities };
        } else {
          const keys = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: keys[0], confidence: 0.75, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / (keys.length - 1)])) };
        }
      }
      return { model: "jev-fake", answers: answers as never, usage: { input_tokens: 1234, output_tokens: 10 }, latencyMs: 5 };
    },
  };
}

const batch = (traceId: string, withExpected = false) => ({
  batch: [
    { id: "e1", type: "trace-create", timestamp: "2026-09-18T00:00:00Z", body: { id: traceId, name: "agent", input: "task?", tags: ["t"], ...(withExpected ? { expectedOutput: "42" } : {}) } },
    { id: "e2", type: "agent-create", timestamp: "2026-09-18T00:00:00Z", body: { id: `${traceId}-a`, traceId, name: "root", startTime: "2026-09-18T00:00:00Z" } },
    { id: "e3", type: "tool-create", timestamp: "2026-09-18T00:00:01Z", body: { id: `${traceId}-s`, traceId, parentObservationId: `${traceId}-a`, name: "search", input: { q: "x" }, startTime: "2026-09-18T00:00:01Z" } },
    { id: "e4", type: "tool-update", timestamp: "2026-09-18T00:00:02Z", body: { id: `${traceId}-s`, traceId, output: ["r1"], endTime: "2026-09-18T00:00:02Z" } },
    { id: "e5", type: "generation-create", timestamp: "2026-09-18T00:00:02Z", body: { id: `${traceId}-g`, traceId, parentObservationId: `${traceId}-a`, name: "answer", model: "m", startTime: "2026-09-18T00:00:02Z", endTime: "2026-09-18T00:00:03Z", output: "42", usage: { input: 10, output: 5 } } },
    { id: "e6", type: "trace-create", timestamp: "2026-09-18T00:00:03Z", body: { id: traceId, output: "42" } },
    { id: "e7", type: "score-create", timestamp: "2026-09-18T00:00:03Z", body: { traceId, name: "thumbs", value: 1 } },
    { id: "bad", type: "nonsense-create", timestamp: "2026-09-18T00:00:03Z", body: {} },
  ],
});

describe("ingestion + eval", () => {
  it("accepts Langfuse-style batches and merges updates", async () => {
    const judge = fakeJudge();
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    const res = await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch("t1")), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { successes: unknown[]; errors: { id: string }[] };
    expect(body.successes).toHaveLength(7);
    expect(body.errors.map((e) => e.id)).toEqual(["bad"]);

    const t = repo.getTrace("t1")!;
    expect(t.output).toBe("42");
    expect(t.name).toBe("agent"); // update didn't wipe name
    const obs = repo.listObservations("t1");
    expect(obs).toHaveLength(3);
    const search = obs.find((o) => o.name === "search")!;
    expect(search.type).toBe("TOOL");
    expect(search.output).toEqual(["r1"]);
    expect(search.end_time).toBe("2026-09-18T00:00:02Z");
    expect(obs.find((o) => o.name === "answer")!.usage_total).toBe(15);
    expect(repo.listScores("t1").map((s) => s.name)).toEqual(["thumbs"]);
    // queued for every enabled evaluator
    expect(repo.queueStats().pending).toBe(3); // sanity, trajectory, outcome
  });

  it("worker judges via jev, writes scores, caches by state hash", async () => {
    const judge = fakeJudge();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, quiet: true });
    await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch("t2")), headers: { "content-type": "application/json" } });
    // make the queue due now
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01T00:00:00Z'");
    const n = await worker!.tick();
    expect(n).toBe(3);
    expect(judge.calls).toBe(1); // `outcome` skipped: no expected_output
    const scores = repo.listScores("t2").filter((s) => s.source === "EVAL");
    const names = scores.map((s) => s.name);
    expect(names).toContain("task_completion");
    expect(names).toContain("trajectory_quality");
    expect(names).toContain("passed");
    expect(names).not.toContain("matches_expected");
    const jd = repo.listJudgments("t2").filter((j) => j.model !== "code");
    expect(jd).toHaveLength(1);
    expect(jd[0]!.cost_usd).toBeCloseTo(1234 * 42 / 1e9, 12);
    expect(repo.queueStats()).toEqual({ done: 2, skipped: 1 });

    // re-ingest identical data → re-queued, but cached: no new jev call
    await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch("t2")), headers: { "content-type": "application/json" } });
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01T00:00:00Z'");
    await worker!.tick();
    expect(judge.calls).toBe(1);

    // REST surface
    const detail = (await (await app.request("/api/v1/traces/t2")).json()) as { scores: unknown[]; judgments: unknown[]; observations: unknown[] };
    expect(detail.observations).toHaveLength(3);
    expect(detail.judgments).toHaveLength(2); // jev + sanity (code)
    const html = await (await app.request("/traces/t2")).text();
    expect(html).toContain("trajectory_quality");
    expect(html).toContain("state sent to jev");
  });

  it("reuses a judgment for an identical trace at zero cost but still scores the new trace", async () => {
    const judge = fakeJudge();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, quiet: true });
    // sequential arrivals (the worker judges a batch concurrently, so simultaneous duplicates both miss the cache)
    for (const id of ["dupA", "dupB"]) {
      await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch(id)), headers: { "content-type": "application/json" } });
      repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01T00:00:00Z'");
      await worker!.tick();
    }
    expect(judge.calls).toBe(1); // identical trajectories → one jev call
    for (const id of ["dupA", "dupB"]) {
      const s = repo.listScores(id).filter((x) => x.source === "EVAL");
      expect(s.some((x) => x.name === "trajectory_quality")).toBe(true);
      expect(s.some((x) => x.name === "sanity_passed")).toBe(true);
    }
    const reused = repo.listJudgments("dupB").find((j) => j.model !== "code")!;
    expect(reused.cost_usd).toBe(0);
    expect(reused.state_meta?.cached_from).toBeDefined();
  });

  it("runs the outcome evaluator when expected_output is present", async () => {
    const judge = fakeJudge();
    const { app, repo, worker } = createApp({ dbPath: ":memory:", judge, quiet: true });
    await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch("t3", true)), headers: { "content-type": "application/json" } });
    repo.db.exec("UPDATE eval_queue SET not_before = '2000-01-01T00:00:00Z'");
    await worker!.tick();
    expect(judge.calls).toBe(2);
    const names = repo.listScores("t3").map((s) => s.name);
    expect(names).toContain("matches_expected");
    expect(names).toContain("outcome_quality");
    expect(names).toContain("outcome_passed");
  });

  it("force-evaluates via REST and supports custom evaluators", async () => {
    const judge = fakeJudge();
    const { app, repo } = createApp({ dbPath: ":memory:", judge, quiet: true });
    await app.request("/api/public/ingestion", { method: "POST", body: JSON.stringify(batch("t4")), headers: { "content-type": "application/json" } });
    const create = await app.request("/api/v1/evaluators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tone", filter: { tags: ["t"] }, questions: { polite: { type: "noul", instructions: "Is `final_output` polite?" } } }),
    });
    expect(create.status).toBe(201);
    const res = await app.request("/api/v1/traces/t4/evaluate?evaluator=tone", { method: "POST" });
    const out = (await res.json()) as { results: Record<string, { status: string }> };
    expect(out.results.tone?.status).toBe("judged");
    expect(repo.listScores("t4").some((s) => s.name === "polite" && s.value === 0.9)).toBe(true);
    // builtin cannot be overwritten
    const clash = await app.request("/api/v1/evaluators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "trajectory", questions: {} }) });
    expect(clash.status).toBe(409);
  });

  it("enforces the API key when configured", async () => {
    const { app } = createApp({ dbPath: ":memory:", judge: null, apiKey: "sk", quiet: true });
    expect((await app.request("/api/v1/traces")).status).toBe(401);
    expect((await app.request("/api/v1/traces", { headers: { authorization: "Bearer sk" } })).status).toBe(200);
    const basic = Buffer.from("pk-lf-xxx:sk").toString("base64");
    expect((await app.request("/api/v1/traces", { headers: { authorization: `Basic ${basic}` } })).status).toBe(200);
    expect((await app.request("/")).status).toBe(200); // UI stays open
  });
});
