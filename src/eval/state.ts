// Turn a trace + its observation tree into the `state` object jev evaluates.
//
// jev's budget is 32k tokens for state + the longest question, so long agent
// trajectories must be compacted deterministically. Strategy, in order:
//   1. per-field truncation (tool outputs are the usual offenders)
//   2. keep head + tail steps, elide the middle with an explicit marker
//   3. truncate task / final_output as a last resort
// The same input always yields the same state, so the state hash doubles as a
// cache key for judgments.
import { createHash } from "node:crypto";
import type { ObservationRow, TraceRow } from "../db/repo.js";

export interface TrajectoryStep {
  i: number;
  type: string;
  name: string | null;
  depth: number;
  duration_ms: number | null;
  level?: string;
  status_message?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  /** per-step answers from observation-level evaluators (fast first pass), folded in for trace-level grading */
  judgments?: Record<string, number | string>;
}

/** A step whose input/output were dropped to fit the budget; skeleton + per-step judgments remain. */
export interface DigestStep {
  i: number;
  type: string;
  name: string | null;
  depth: number;
  elided: true;
  level?: string;
  status_message?: string;
  judgments?: Record<string, number | string>;
}

export type StepJudgments = Map<string, Record<string, number | string>>; // observation id → answers

export interface TraceState {
  task: unknown;
  expected_output?: unknown;
  final_output: unknown;
  trajectory: (TrajectoryStep | DigestStep | { omitted_steps: number })[];
  /** code-computed roll-up of the per-step judgments (see eval/steps.ts) */
  step_summary?: Record<string, number | string | null>;
  stats: {
    steps: number;
    llm_calls: number;
    tool_calls: number;
    errors: number;
    warnings: number;
    duration_ms: number | null;
    total_tokens: number | null;
  };
}

export interface StateMeta {
  chars: number;
  truncated: boolean;
  field_cap: number | null;
  steps_total: number;
  /** steps present with input/output (digest steps are not counted) */
  steps_kept: number;
  /** steps present only as a digest (no input/output) */
  steps_digested?: number;
  /** number of steps that carried per-step judgments */
  steps_judged?: number;
}

const LLM_TYPES = new Set(["GENERATION"]);
const TOOL_TYPES = new Set(["TOOL"]);

function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clip(v: unknown, cap: number): unknown {
  if (v === null || v === undefined) return v;
  const s = toText(v);
  if (s.length <= cap) return v; // keep structure when it fits
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return `${s.slice(0, head)} …[${s.length - cap} chars omitted]… ${s.slice(s.length - tail)}`;
}

function depthOf(o: ObservationRow, byId: Map<string, ObservationRow>): number {
  let d = 0;
  let cur = o;
  const seen = new Set<string>();
  while (cur.parent_observation_id && byId.has(cur.parent_observation_id) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parent_observation_id)!;
    d++;
    if (d > 32) break;
  }
  return d;
}

function ms(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) ? d : null;
}

export function buildSteps(observations: ObservationRow[], judgments?: StepJudgments): TrajectoryStep[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  return observations.map((o, i) => {
    const step: TrajectoryStep = {
      i,
      type: o.type,
      name: o.name,
      depth: depthOf(o, byId),
      duration_ms: ms(o.start_time, o.end_time),
    };
    if (o.level && o.level !== "DEFAULT") step.level = o.level;
    if (o.status_message) step.status_message = o.status_message;
    if (o.model) step.model = o.model;
    if (o.input !== null && o.input !== undefined) step.input = o.input;
    if (o.output !== null && o.output !== undefined) step.output = o.output;
    const jd = judgments?.get(o.id);
    if (jd && Object.keys(jd).length) step.judgments = jd;
    return step;
  });
}

function digest(s: TrajectoryStep): DigestStep {
  const d: DigestStep = { i: s.i, type: s.type, name: s.name, depth: s.depth, elided: true };
  if (s.level) d.level = s.level;
  if (s.status_message) d.status_message = s.status_message;
  if (s.judgments) d.judgments = s.judgments;
  return d;
}

function stats(trace: TraceRow, observations: ObservationRow[]): TraceState["stats"] {
  let llm = 0,
    tool = 0,
    errors = 0,
    warnings = 0,
    tokens = 0,
    sawTokens = false;
  let minStart: number | null = null,
    maxEnd: number | null = null;
  for (const o of observations) {
    if (LLM_TYPES.has(o.type)) llm++;
    if (TOOL_TYPES.has(o.type)) tool++;
    if (o.level === "ERROR") errors++;
    if (o.level === "WARNING") warnings++;
    if (o.usage_total != null) {
      tokens += o.usage_total;
      sawTokens = true;
    }
    const s = Date.parse(o.start_time);
    const e = o.end_time ? Date.parse(o.end_time) : NaN;
    if (Number.isFinite(s)) minStart = minStart === null ? s : Math.min(minStart, s);
    if (Number.isFinite(e)) maxEnd = maxEnd === null ? e : Math.max(maxEnd, e);
  }
  const t0 = Date.parse(trace.timestamp);
  if (Number.isFinite(t0)) minStart = minStart === null ? t0 : Math.min(minStart, t0);
  return {
    steps: observations.length,
    llm_calls: llm,
    tool_calls: tool,
    errors,
    warnings,
    duration_ms: minStart !== null && maxEnd !== null ? maxEnd - minStart : null,
    total_tokens: sawTokens ? tokens : null,
  };
}

const FIELD_CAPS = [4000, 1500, 600, 250, 100];

export interface TraceStateOptions {
  /** per-step answers from observation-level evaluators, keyed by observation id */
  stepJudgments?: StepJudgments;
  /** roll-up of those answers computed in code */
  stepSummary?: Record<string, number | string | null>;
}

export function buildTraceState(trace: TraceRow, observations: ObservationRow[], budgetChars: number, opts: TraceStateOptions = {}): { state: TraceState; meta: StateMeta } {
  const allSteps = buildSteps(observations, opts.stepJudgments);
  const judged = allSteps.filter((s) => s.judgments).length;
  const base = (steps: TraceState["trajectory"], taskCap: number | null): TraceState => {
    const st: TraceState = {
      task: taskCap ? clip(trace.input, taskCap) : trace.input,
      final_output: taskCap ? clip(trace.output, taskCap) : trace.output,
      trajectory: steps,
      stats: stats(trace, observations),
    };
    if (trace.expected_output !== null && trace.expected_output !== undefined) {
      st.expected_output = taskCap ? clip(trace.expected_output, taskCap) : trace.expected_output;
    }
    if (opts.stepSummary && Object.keys(opts.stepSummary).length) st.step_summary = opts.stepSummary;
    return st;
  };
  const size = (s: TraceState) => JSON.stringify(s).length;
  const metaOf = (chars: number, truncated: boolean, field_cap: number | null, kept: number, digested = 0): StateMeta => ({
    chars,
    truncated,
    field_cap,
    steps_total: allSteps.length,
    steps_kept: kept,
    ...(digested ? { steps_digested: digested } : {}),
    ...(judged ? { steps_judged: judged } : {}),
  });

  // 1. untouched
  let state = base(allSteps, null);
  let chars = size(state);
  if (chars <= budgetChars) {
    return { state, meta: metaOf(chars, false, null, allSteps.length) };
  }

  // 2. progressively cap each step's input/output
  let cap: number | null = null;
  let capped = allSteps;
  for (const c of FIELD_CAPS) {
    cap = c;
    capped = allSteps.map((s) => ({ ...s, input: clip(s.input, c), output: clip(s.output, c) }));
    state = base(capped, null);
    chars = size(state);
    if (chars <= budgetChars) {
      return { state, meta: metaOf(chars, true, cap, allSteps.length) };
    }
  }

  // 3. head + tail keep their input/output; the middle stays as a digest (skeleton + per-step
  //    judgments), so the trace-level grader still sees every step and what the step grader said.
  let keep = Math.max(2, Math.floor(capped.length / 2));
  while (keep >= 2) {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const middle = capped.slice(head, capped.length - tail).map(digest);
    const steps: TraceState["trajectory"] = [...capped.slice(0, head), ...middle, ...(tail > 0 ? capped.slice(capped.length - tail) : [])];
    state = base(steps, null);
    chars = size(state);
    if (chars <= budgetChars) {
      return { state, meta: metaOf(chars, true, cap, keep, middle.length) };
    }
    keep = Math.floor(keep / 2);
  }

  // 3b. even the digest is too long (thousands of steps): elide the middle with a counter
  keep = Math.max(2, Math.floor(capped.length / 2));
  while (keep >= 2) {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const steps: TraceState["trajectory"] = [
      ...capped.slice(0, head),
      { omitted_steps: capped.length - keep },
      ...(tail > 0 ? capped.slice(capped.length - tail) : []),
    ];
    state = base(steps, null);
    chars = size(state);
    if (chars <= budgetChars) {
      return { state, meta: metaOf(chars, true, cap, keep) };
    }
    keep = Math.floor(keep / 2);
  }

  // 4. task / outputs themselves are huge; clip them too
  const steps: TraceState["trajectory"] = [capped[0]!, { omitted_steps: Math.max(0, capped.length - 2) }, ...(capped.length > 1 ? [capped[capped.length - 1]!] : [])];
  const perField = Math.max(500, Math.floor(budgetChars / 4));
  state = base(steps, perField);
  chars = size(state);
  return { state, meta: metaOf(chars, true, cap, Math.min(2, capped.length)) };
}

export function hashState(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Observation-level state: one step in focus, with just enough surrounding
// context to judge it on its own: the task, the last few steps WITH clipped
// input/output (what the agent knew at this point), the most recent error
// before this step, and what the run finally returned.
export interface PreviousStep {
  i: number;
  type: string;
  name: string | null;
  level?: string;
  status_message?: string;
  input?: unknown;
  output?: unknown;
}

export interface ObservationState {
  task: unknown;
  step: TrajectoryStep;
  context: {
    position: string; // "step 4 of 12"
    parent: string | null;
    previous_steps: PreviousStep[];
    /** steps before the window that are not shown */
    previous_steps_omitted: number;
    /** most recent ERROR step before this one (so "is this step a recovery?" is answerable) */
    last_error: { i: number; name: string | null; status_message: string | null } | null;
    final_output: unknown;
  };
}

export function buildObservationState(
  trace: TraceRow,
  observations: ObservationRow[],
  target: ObservationRow,
  budgetChars: number,
  window = 8,
): { state: ObservationState; meta: StateMeta } {
  const steps = buildSteps(observations);
  const idx = observations.findIndex((o) => o.id === target.id);
  const step = steps[idx] ?? buildSteps([target])[0]!;
  const parent = target.parent_observation_id ? observations.find((o) => o.id === target.parent_observation_id) : undefined;
  const from = Math.max(0, idx - window);
  const prevRaw = steps.slice(from, Math.max(0, idx));
  let lastError: ObservationState["context"]["last_error"] = null;
  for (let k = idx - 1; k >= 0; k--) {
    const o = observations[k]!;
    if (o.level === "ERROR") {
      lastError = { i: k, name: o.name, status_message: o.status_message };
      break;
    }
  }
  const prev = (ioCap: number): PreviousStep[] =>
    prevRaw.map((s) => {
      const p: PreviousStep = { i: s.i, type: s.type, name: s.name };
      if (s.level) p.level = s.level;
      if (s.status_message) p.status_message = s.status_message;
      if (ioCap > 0) {
        if (s.input !== undefined) p.input = clip(s.input, ioCap);
        if (s.output !== undefined) p.output = clip(s.output, ioCap);
      }
      return p;
    });
  const make = (cap: number | null, prevCap: number): ObservationState => ({
    task: cap ? clip(trace.input, cap) : trace.input,
    step: cap ? { ...step, input: clip(step.input, cap), output: clip(step.output, cap) } : step,
    context: {
      position: `step ${idx + 1} of ${observations.length}`,
      parent: parent?.name ?? null,
      previous_steps: prev(prevCap),
      previous_steps_omitted: from,
      last_error: lastError,
      final_output: cap ? clip(trace.output, cap) : trace.output,
    },
  });
  const meta = (st: ObservationState, cap: number | null): { state: ObservationState; meta: StateMeta } => ({
    state: st,
    meta: { chars: JSON.stringify(st).length, truncated: cap !== null, field_cap: cap, steps_total: observations.length, steps_kept: 1 },
  });
  // previous steps carry ~400 chars of input/output each; shrink them first, then the focus step
  let state = make(null, 400);
  if (JSON.stringify(state).length <= budgetChars) return meta(state, null);
  for (const [c, pc] of [
    [8000, 300],
    [3000, 200],
    [1000, 120],
    [400, 0],
  ] as const) {
    state = make(c, pc);
    if (JSON.stringify(state).length <= budgetChars) return meta(state, c);
  }
  const last = Math.max(200, Math.floor(budgetChars / 6));
  return meta(make(last, 0), last);
}
