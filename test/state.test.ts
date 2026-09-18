import { describe, it, expect } from "vitest";
import { buildTraceState, hashState } from "../src/eval/state.js";
import type { ObservationRow, TraceRow } from "../src/db/repo.js";

const now = "2026-09-18T00:00:00.000Z";
const trace = (over: Partial<TraceRow> = {}): TraceRow => ({
  id: "t1", project_id: "default", name: "agent", user_id: null, session_id: null, input: "do the thing", output: "done", expected_output: null,
  metadata: null, tags: null, release: null, version: null, environment: null, source: "local", external_url: null, timestamp: now, created_at: now, updated_at: now, ...over,
});
const obs = (i: number, over: Partial<ObservationRow> = {}): ObservationRow => ({
  id: `o${i}`, trace_id: "t1", parent_observation_id: null, type: "TOOL", name: `tool${i}`, start_time: now, end_time: "2026-09-18T00:00:01.000Z",
  completion_start_time: null, input: { q: i }, output: "x".repeat(5000), metadata: null, level: "DEFAULT", status_message: null, model: null,
  model_parameters: null, usage_input: null, usage_output: null, usage_total: 10, cost_usd: null, created_at: now, updated_at: now, ...over,
});

describe("buildTraceState", () => {
  it("keeps everything when under budget", () => {
    const { state, meta } = buildTraceState(trace(), [obs(0, { output: "small" })], 100_000);
    expect(meta.truncated).toBe(false);
    expect(state.trajectory).toHaveLength(1);
    expect(state.stats.tool_calls).toBe(1);
    expect(state.stats.total_tokens).toBe(10);
    expect(state).not.toHaveProperty("expected_output");
  });
  it("includes expected_output when present", () => {
    const { state } = buildTraceState(trace({ expected_output: "42" }), [], 100_000);
    expect(state.expected_output).toBe("42");
  });
  it("caps fields before dropping steps", () => {
    const o = Array.from({ length: 10 }, (_, i) => obs(i));
    const { state, meta } = buildTraceState(trace(), o, 20_000);
    expect(meta.truncated).toBe(true);
    expect(meta.steps_kept).toBe(10);
    expect(meta.field_cap).not.toBeNull();
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(20_000);
  });
  it("elides the middle when there are too many steps", () => {
    const o = Array.from({ length: 400 }, (_, i) => obs(i, { output: "y".repeat(300) }));
    const { state, meta } = buildTraceState(trace(), o, 15_000);
    expect(meta.steps_kept).toBeLessThan(400);
    expect(state.trajectory.some((s) => "omitted_steps" in s)).toBe(true);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(15_000);
  });
  it("is deterministic (hash is a cache key)", () => {
    const a = buildTraceState(trace(), [obs(0)], 1000).state;
    const b = buildTraceState(trace(), [obs(0)], 1000).state;
    expect(hashState(a)).toBe(hashState(b));
  });
  it("computes depth from parent links", () => {
    const o = [obs(0, { type: "AGENT" }), obs(1, { parent_observation_id: "o0" }), obs(2, { parent_observation_id: "o1", type: "GENERATION" })];
    const { state } = buildTraceState(trace(), o, 100_000);
    const steps = state.trajectory as { depth: number }[];
    expect(steps.map((s) => s.depth)).toEqual([0, 1, 2]);
    expect(state.stats.llm_calls).toBe(1);
  });
});
