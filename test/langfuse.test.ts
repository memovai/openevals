import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Questions } from "@typesafe-ai/sdk";
import { createApp } from "../src/server.js";
import type { Judge } from "../src/eval/jev.js";
import { RateLimiter } from "../src/eval/jev.js";
import { LangfuseClient, type LangfuseObservationV2 } from "../src/sources/langfuse/client.js";
import { LangfuseSync } from "../src/sources/langfuse/sync.js";
import { parseIo, toTraceRow } from "../src/sources/langfuse/map.js";
import { config } from "../src/config.js";

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

/** In-memory Langfuse: v2 observations with cursor paging, ingestion, v3 scores, annotation queue. */
function fakeLangfuse(observations: LangfuseObservationV2[], annotations: Record<string, unknown>[] = []) {
  const app = new Hono();
  const ingested: Record<string, unknown>[] = [];
  const queued: { queueId: string; body: unknown }[] = [];
  const auth: string[] = [];
  app.use("*", async (c, next) => {
    auth.push(c.req.header("authorization") ?? "");
    await next();
  });
  app.get("/api/public/v2/observations", (c) => {
    const q = c.req.query();
    const from = Date.parse(q.fromStartTime!);
    const to = q.toStartTime ? Date.parse(q.toStartTime) : Infinity;
    let rows = observations.filter((o) => Date.parse(o.startTime) >= from && Date.parse(o.startTime) < to);
    if (q.traceId) rows = rows.filter((o) => o.traceId === q.traceId);
    rows.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    const limit = Number(q.limit ?? 50);
    const start = q.cursor ? Number(Buffer.from(q.cursor, "base64").toString()) : 0;
    const page = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? Buffer.from(String(start + limit)).toString("base64") : undefined;
    // v2 returns input/output as raw strings
    const data = page.map((o) => ({ ...o, input: o.input === undefined ? undefined : typeof o.input === "string" ? o.input : JSON.stringify(o.input), output: o.output === undefined ? undefined : typeof o.output === "string" ? o.output : JSON.stringify(o.output) }));
    return c.json({ data, meta: { cursor: next } });
  });
  app.post("/api/public/ingestion", async (c) => {
    const { batch } = (await c.req.json()) as { batch: { id: string; body: Record<string, unknown> }[] };
    const successes: { id: string; status: number }[] = [];
    const errors: { id: string; status: number; message: string }[] = [];
    for (const ev of batch) {
      if (ev.body.name === "reject_me") errors.push({ id: ev.id, status: 400, message: "bad" });
      else {
        ingested.push(ev.body);
        successes.push({ id: ev.id, status: 201 });
      }
    }
    return c.json({ successes, errors }, 207);
  });
  app.get("/api/public/v3/scores", (c) => c.json({ data: annotations.filter((a) => a.source === c.req.query("source")), meta: {} }));
  app.post("/api/public/annotation-queues/:id/items", async (c) => {
    queued.push({ queueId: c.req.param("id"), body: await c.req.json() });
    return c.json({ id: "item" }, 200);
  });
  const f: typeof fetch = (input, init) => Promise.resolve(app.request(input instanceof URL ? input.toString() : (input as string), init as RequestInit));
  return { app, ingested, queued, auth, fetch: f };
}

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const iso = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString();
const obs = (o: Partial<LangfuseObservationV2> & { id: string; traceId: string; startTime: string }): LangfuseObservationV2 => ({
  endTime: null,
  projectId: "proj1",
  parentObservationId: null,
  type: "SPAN",
  level: "DEFAULT",
  ...o,
});

function scenario() {
  return [
    // trace A: root agent span with trace-level fields, one tool, one generation (all settled)
    obs({ id: "a-root", traceId: "A", startTime: iso(-600), endTime: iso(-590), type: "AGENT", name: "researcher", isRootObservation: true, traceName: "research-agent", tags: ["prod"], userId: "u1", sessionId: "s1", environment: "production", input: { task: "find the price" }, output: "$12" }),
    obs({ id: "a-search", traceId: "A", startTime: iso(-598), endTime: iso(-597), parentObservationId: "a-root", type: "TOOL", name: "search", input: { q: "price" }, output: "12 USD" }),
    obs({ id: "a-gen", traceId: "A", startTime: iso(-596), endTime: iso(-595), parentObservationId: "a-root", type: "GENERATION", name: "answer", model: "claude-sonnet-5", input: "ctx", output: "$12", usageDetails: { input: 10, output: 5, total: 15 } }),
    // trace B: still running (too young to be settled) → must not be pulled yet
    obs({ id: "b-root", traceId: "B", startTime: iso(-10), type: "AGENT", name: "young", isRootObservation: true, input: "x" }),
    // trace C: an ERROR tool step whose root started long before the window
    obs({ id: "c-root", traceId: "C", startTime: iso(-100_000), endTime: iso(-500), type: "AGENT", name: "old-root", isRootObservation: true, input: "long task", output: "gave up" }),
    obs({ id: "c-tool", traceId: "C", startTime: iso(-520), endTime: iso(-519), parentObservationId: "c-root", type: "TOOL", name: "flight_search", input: { from: "SFO" }, output: { error: "429" }, level: "ERROR", statusMessage: "rate limited" }),
  ];
}

const syncOpts = (over: Partial<typeof config.langfuse> = {}) => ({
  ...config.langfuse,
  host: "http://langfuse.test",
  publicKey: "pk",
  secretKey: "sk",
  settleS: 60,
  overlapS: 120,
  lookbackS: 3600,
  pageLimit: 2, // force paging
  maxPerTick: 1000,
  environments: [],
  traceNames: [],
  writeBack: true,
  writeBackScores: [],
  writeBackSteps: true,
  reviewQueueId: undefined,
  verdictScore: "passed",
  publicUrl: "https://evals.example.com",
  now: () => T0,
  ...over,
});

describe("langfuse mapping", () => {
  it("parses raw-string IO and builds the trace from the root observation", () => {
    expect(parseIo('{"a":1}')).toEqual({ a: 1 });
    expect(parseIo("plain text")).toBe("plain text");
    expect(parseIo("[1,2")).toBe("[1,2");
    const rows = scenario().filter((o) => o.traceId === "A");
    const t = toTraceRow("A", rows, { host: "http://lf", traceUrl: (p, id) => `http://lf/project/${p}/traces/${id}` });
    expect(t).toMatchObject({ id: "A", source: "langfuse", name: "research-agent", user_id: "u1", session_id: "s1", tags: ["prod"], environment: "production", external_url: "http://lf/project/proj1/traces/A" });
    expect(t.timestamp).toBe(iso(-600));
  });
});

describe("langfuse connector", () => {
  it("pulls settled observations, fetches missing roots, judges, writes scores back, pulls annotations", async () => {
    const annotations = [
      { id: "ann1", name: "passed", source: "ANNOTATION", timestamp: iso(-100), dataType: "BOOLEAN", value: 0, subject: { kind: "trace", id: "A" }, authorUserId: "reviewer", comment: "wrong price" },
      { id: "ann2", name: "helpfulness", source: "ANNOTATION", timestamp: iso(-100), dataType: "NUMERIC", value: 0.7, subject: { kind: "observation", id: "a-gen", traceId: "A" } },
      { id: "ann3", name: "passed", source: "ANNOTATION", timestamp: iso(-100), dataType: "BOOLEAN", value: 1, subject: { kind: "trace", id: "unknown-trace" } },
    ];
    const lf = fakeLangfuse(scenario(), annotations);
    const judge = fakeJudge();
    const { app, repo, worker } = createApp({
      dbPath: ":memory:",
      judge,
      quiet: true,
      langfuse: (repo, schedule) => new LangfuseSync(repo, new LangfuseClient({ host: "http://langfuse.test", publicKey: "pk", secretKey: "sk", fetch: lf.fetch }), schedule, syncOpts(), { info() {}, warn() {}, error() {} }),
    });
    const sync = (await (await app.request("/api/v1/sync")).json()) as { source: string; langfuse: { host: string } };
    expect(sync.source).toBe("langfuse");
    expect(sync.langfuse.host).toBe("http://langfuse.test");

    // ---- pull
    const pull = (await (await app.request("/api/v1/sync/poll", { method: "POST" })).json()) as { ok: boolean; result: { observations: number; traces: number; pages: number } };
    expect(pull.ok).toBe(true);
    expect(pull.result.traces).toBe(2); // A and C; B is younger than settle
    expect(pull.result.pages).toBeGreaterThan(1); // pageLimit 2 forced paging
    expect(lf.auth[0]).toBe("Basic " + Buffer.from("pk:sk").toString("base64"));
    const a = repo.getTrace("A")!;
    expect(a.source).toBe("langfuse");
    expect(a.name).toBe("research-agent");
    expect(a.input).toEqual({ task: "find the price" });
    expect(a.output).toBe("$12");
    expect(a.external_url).toBe("http://langfuse.test/project/proj1/traces/A");
    expect(repo.listObservations("A").map((o) => o.type)).toEqual(["AGENT", "TOOL", "GENERATION"]);
    expect(repo.listObservations("A").find((o) => o.id === "a-gen")?.usage_total).toBe(15);
    // C's root started outside the window → fetched by traceId so the task is known
    const c = repo.getTrace("C")!;
    expect(c.input).toBe("long task");
    expect(repo.listObservations("C")).toHaveLength(2);
    expect(repo.getTrace("B")).toBeNull();
    expect(repo.getSyncState("langfuse:watermark")).toBe(iso(-60));
    // re-poll with the same clock: window is empty, nothing changes
    const again = (await (await app.request("/api/v1/sync/poll", { method: "POST" })).json()) as { result: { observations: number } };
    expect(again.result.observations).toBe(0);

    // ---- judge (queue was scheduled with settle 0)
    await worker!.tick();
    const scoresA = repo.listScores("A").filter((s) => s.source === "EVAL");
    expect(scoresA.some((s) => s.name === "passed")).toBe(true);
    expect(scoresA.some((s) => s.observation_id === "a-search" && s.name === "progress")).toBe(true);
    expect(scoresA.every((s) => !s.synced_at)).toBe(true);

    // ---- write back
    const wb = (await (await app.request("/api/v1/sync/writeback", { method: "POST" })).json()) as { result: { written: number; rejected: number } };
    expect(wb.result.written).toBeGreaterThan(0);
    expect(wb.result.rejected).toBe(0);
    const passed = lf.ingested.find((b) => b.traceId === "A" && b.name === "passed")!;
    // the fake judge answers 0.9 to every noul, including `unsafe_or_out_of_scope_action`, so the pass gate fails
    expect(passed).toMatchObject({ dataType: "BOOLEAN", value: 0 });
    const pmeta = (passed.metadata as { openevals: { url: string; kind: string; judgment_id: string } }).openevals;
    expect(pmeta.kind).toBe("pass");
    expect(pmeta.url).toBe(`https://evals.example.com/traces/A#judgment-${pmeta.judgment_id}`);
    const step = lf.ingested.find((b) => b.observationId === "a-search" && b.name === "progress")!;
    expect(step.traceId).toBe("A");
    expect((step.metadata as { openevals: { probabilities: unknown; confidence: number } }).openevals.confidence).toBe(0.9);
    const cat = lf.ingested.find((b) => b.traceId === "A" && b.name === "failure_mode")!;
    expect(cat).toMatchObject({ dataType: "CATEGORICAL", value: "none" });
    expect(repo.unsyncedScores("langfuse")).toHaveLength(0);
    // idempotent: second write-back sends nothing
    const wb2 = (await (await app.request("/api/v1/sync/writeback", { method: "POST" })).json()) as { result: { written: number } };
    expect(wb2.result.written).toBe(0);

    // ---- annotations → local ANNOTATION scores → calibration
    const ann = (await (await app.request("/api/v1/sync/annotations", { method: "POST" })).json()) as { result: { pulled: number } };
    expect(ann.result.pulled).toBe(2); // ann3 is for a trace we do not have
    const human = repo.listScores("A").filter((s) => s.source === "ANNOTATION");
    expect(human.find((s) => s.name === "passed")).toMatchObject({ value: 0, data_type: "BOOLEAN", comment: "wrong price" });
    expect(human.find((s) => s.name === "helpfulness")).toMatchObject({ value: 0.7, observation_id: "a-gen" });
    expect(repo.annotatedTraceIds()).toEqual(["A"]);
    const cal = (await (await app.request("/api/v1/calibration")).json()) as { data: { name: string; false_pass: number; agreement: number | null }[] };
    expect(cal.data.find((r) => r.name === "passed")?.agreement).toBe(1); // jev failed it, human failed it

    // ---- status page + trace page
    const home = await (await app.request("/")).text();
    expect(home).toContain("Langfuse connector");
    expect(home).toContain("langfuse.test");
    const page = await (await app.request("/traces/A")).text();
    expect(page).toContain("open in langfuse");
    expect(page).toContain("Annotate this trace in Langfuse");
    expect(page).not.toContain('name="verdict"');
  });

  it("honours write-back filters, marks 4xx rejections, and queues failed traces for review", async () => {
    const lf = fakeLangfuse(scenario());
    const judge = fakeJudge();
    const { app, repo, worker } = createApp({
      dbPath: ":memory:",
      judge,
      quiet: true,
      langfuse: (repo, schedule) => new LangfuseSync(repo, new LangfuseClient({ host: "http://langfuse.test", publicKey: "pk", secretKey: "sk", fetch: lf.fetch }), schedule, syncOpts({ writeBackSteps: false, writeBackScores: ["passed", "trajectory_quality", "reject_me"], reviewQueueId: "q-review" }), { info() {}, warn() {}, error() {} }),
    });
    await app.request("/api/v1/sync/poll", { method: "POST" });
    await worker!.tick();
    // plant a score Langfuse will reject and a failing pass score on C
    repo.insertScore({ trace_id: "A", observation_id: null, name: "reject_me", value: 1, string_value: null, data_type: "NUMERIC", source: "EVAL", comment: null, metadata: { kind: "noul" }, evaluator_id: "x", judgment_id: null });
    repo.insertScore({ trace_id: "C", observation_id: null, name: "passed", value: 0, string_value: null, data_type: "BOOLEAN", source: "EVAL", comment: null, metadata: { kind: "pass" }, evaluator_id: "x", judgment_id: null });
    const wb = (await (await app.request("/api/v1/sync/writeback", { method: "POST" })).json()) as { result: { written: number; rejected: number; queued: number } };
    expect(wb.result.rejected).toBe(1);
    expect(wb.result.queued).toBe(2); // A failed its pass gate under the fake judge; C has the planted failing score
    expect(lf.queued.map((q) => q.queueId)).toEqual(["q-review", "q-review"]);
    expect(new Set(lf.queued.map((q) => (q.body as { objectId: string }).objectId))).toEqual(new Set(["A", "C"]));
    expect(lf.queued.every((q) => (q.body as { objectType: string }).objectType === "TRACE")).toBe(true);
    expect(lf.ingested.every((b) => !b.observationId)).toBe(true); // steps not written
    expect(new Set(lf.ingested.map((b) => b.name))).toEqual(new Set(["passed", "trajectory_quality"]));
    expect(repo.unsyncedScores("langfuse")).toHaveLength(0); // filtered + rejected are marked, not retried forever
    const status = (await (await app.request("/api/v1/sync")).json()) as { langfuse: { scores_rejected: string; last_write_back_error: string } };
    expect(status.langfuse.scores_rejected).toBe("1");
    expect(status.langfuse.last_write_back_error).toContain("400");
    // second run: the same failed trace is not queued twice
    const wb2 = (await (await app.request("/api/v1/sync/writeback", { method: "POST" })).json()) as { result: { queued: number } };
    expect(wb2.result.queued).toBe(0);
  });

  it("filters by trace name and environment, and is off without credentials", async () => {
    const lf = fakeLangfuse(scenario());
    const { app, repo } = createApp({
      dbPath: ":memory:",
      judge: null,
      quiet: true,
      langfuse: (repo, schedule) => new LangfuseSync(repo, new LangfuseClient({ host: "http://langfuse.test", publicKey: "pk", secretKey: "sk", fetch: lf.fetch }), schedule, syncOpts({ traceNames: ["research-agent"] }), { info() {}, warn() {}, error() {} }),
    });
    const pull = (await (await app.request("/api/v1/sync/poll", { method: "POST" })).json()) as { result: { traces: number } };
    expect(pull.result.traces).toBe(1);
    expect(repo.getTrace("A")).not.toBeNull();
    expect(repo.getTrace("C")).toBeNull();
    const { app: app2 } = createApp({ dbPath: ":memory:", judge: null, quiet: true, langfuse: null });
    expect((await app2.request("/api/v1/sync/poll", { method: "POST" })).status).toBe(503);
    const home = await (await app2.request("/")).text();
    expect(home).toContain("No Langfuse connector configured");
  });
});

describe("jev rate limiter", () => {
  it("caps concurrency and requests per minute", async () => {
    const lim = new RateLimiter(3, 2);
    let inFlight = 0,
      peak = 0;
    const run = async () => {
      const release = await lim.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      release();
    };
    await Promise.all([run(), run(), run()]);
    expect(peak).toBe(2);
    expect(lim.stats.last_minute).toBe(3);
    // the 4th request in the same minute has to wait for the window
    let resolved = false;
    const p = lim.acquire().then((rel) => {
      resolved = true;
      rel();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(lim.stats.waiting).toBe(1);
    lim.rpm = 10; // loosen the limit → the waiter proceeds on its next wake
    (lim as unknown as { wake(): void }).wake();
    await p;
    expect(resolved).toBe(true);
  });
});
