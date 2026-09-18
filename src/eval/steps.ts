// Per-step grading roll-ups. Observation-level evaluators answer a few atomic
// questions about every step (progress, on task, redundant, corrective, ...);
// this module turns those answers into (a) a `judgments` map per step that is
// folded into the trace-level state, and (b) trace-level metrics computed in
// code — credit assignment for long runs: where did it first go off track, how
// much was wasted, how long did stalls last, did it recover after errors.
//
// Nothing here calls a model. Per Anthropic's eval guide the outcome decides
// pass/fail; these metrics are for diagnosis, not for the pass gate.
import type { ObservationRow, ScoreRow } from "../db/repo.js";
import type { StepJudgments } from "./state.js";

/** Conventional question ids the roll-up understands (anything else is still folded into the state). */
export const STEP_QUESTIONS = {
  progress: "progress", // score: 0 regressed · 1 no progress · 2 progress
  onTask: "on_task", // noul
  redundant: "redundant", // noul
  corrective: "corrective", // noul
} as const;

export interface StepSummary {
  steps_judged: number;
  /** mean normalised progress (0..1) over judged steps */
  progress_mean: number | null;
  /** judged steps whose rounded progress level < top level */
  no_progress_steps: number | null;
  /** longest run of consecutive judged steps without progress */
  longest_stall: number | null;
  /** redundant ≥ 0.5 OR no progress */
  wasted_steps: number | null;
  wasted_fraction: number | null;
  /** on_task < 0.5 */
  off_task_steps: number | null;
  /** 0-based index (in the observation list) of the first step judged off task; null if none */
  first_off_task_step: number | null;
  /** ERROR steps that were followed (within the run) by a step that made progress */
  errors: number;
  errors_recovered: number | null;
  error_recovery_rate: number | null;
  /** mean number of steps from an ERROR to the next step with progress */
  mean_steps_to_recover: number | null;
  /** mean of each observation-level composite score, keyed `<name>_mean` */
  composites: Record<string, number>;
}

const isPassKind = (s: ScoreRow) => s.metadata?.kind === "pass";
const isComposite = (s: ScoreRow) => s.metadata?.kind === "composite";

/** observation id → { question: value } from observation-level EVAL scores (latest per name wins). */
export function stepJudgmentsFromScores(scores: ScoreRow[]): StepJudgments {
  const out: StepJudgments = new Map();
  for (const s of scores) {
    if (s.source !== "EVAL" || !s.observation_id || isPassKind(s)) continue;
    const m = out.get(s.observation_id) ?? {};
    if (s.string_value !== null) m[s.name] = s.string_value;
    else if (s.value !== null) m[s.name] = Math.round(s.value * 100) / 100;
    out.set(s.observation_id, m);
  }
  return out;
}

/** Top level of a score answer (levels are 0..n-1); falls back to 2 for the conventional 3-level `progress`. */
function topLevel(s: ScoreRow | undefined): number {
  const legend = s?.metadata?.legend as Record<string, unknown> | undefined;
  return legend ? Math.max(1, Object.keys(legend).length - 1) : 2;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarizeSteps(observations: ObservationRow[], scores: ScoreRow[]): StepSummary {
  const byObs = new Map<string, Map<string, ScoreRow>>();
  for (const s of scores) {
    if (s.source !== "EVAL" || !s.observation_id) continue;
    const m = byObs.get(s.observation_id) ?? new Map<string, ScoreRow>();
    m.set(s.name, s); // scores are ordered by timestamp asc → latest wins
    byObs.set(s.observation_id, m);
  }
  const compAcc = new Map<string, number[]>();
  const progress: (number | null)[] = []; // per observation index: normalised progress or null (unjudged)
  const madeProgress: (boolean | null)[] = [];
  let judged = 0,
    noProgress = 0,
    wasted = 0,
    offTask = 0,
    sawProgress = false,
    sawOnTask = false,
    sawRedundant = false;
  let firstOffTask: number | null = null;
  observations.forEach((o, idx) => {
    const m = byObs.get(o.id);
    if (!m) {
      progress.push(null);
      madeProgress.push(null);
      return;
    }
    judged++;
    for (const s of m.values()) if (isComposite(s) && s.value !== null) compAcc.set(s.name, [...(compAcc.get(s.name) ?? []), s.value]);
    const p = m.get(STEP_QUESTIONS.progress);
    let stepProgressed: boolean | null = null;
    if (p && p.value !== null) {
      sawProgress = true;
      const top = topLevel(p);
      progress.push(p.value / top);
      stepProgressed = Math.round(p.value) >= top;
      if (!stepProgressed) noProgress++;
    } else progress.push(null);
    madeProgress.push(stepProgressed);
    const r = m.get(STEP_QUESTIONS.redundant);
    if (r && r.value !== null) sawRedundant = true;
    const redundant = (r?.value ?? 0) >= 0.5;
    if (redundant || stepProgressed === false) wasted++;
    const t = m.get(STEP_QUESTIONS.onTask);
    if (t && t.value !== null) {
      sawOnTask = true;
      if (t.value < 0.5) {
        offTask++;
        if (firstOffTask === null) firstOffTask = idx;
      }
    }
  });

  // longest stall: consecutive judged steps with progress below top
  let longest = 0,
    run = 0;
  for (const mp of madeProgress) {
    if (mp === false) {
      run++;
      longest = Math.max(longest, run);
    } else if (mp === true) run = 0;
  }

  // error recovery: for each ERROR observation, distance to the next step that made progress
  let errors = 0,
    recovered = 0;
  const dists: number[] = [];
  observations.forEach((o, idx) => {
    if (o.level !== "ERROR") return;
    errors++;
    for (let k = idx + 1; k < observations.length; k++) {
      if (madeProgress[k] === true) {
        recovered++;
        dists.push(k - idx);
        break;
      }
    }
  });

  const hasWaste = sawProgress || sawRedundant;
  return {
    steps_judged: judged,
    progress_mean: sawProgress ? mean(progress.filter((x): x is number => x !== null)) : null,
    no_progress_steps: sawProgress ? noProgress : null,
    longest_stall: sawProgress ? longest : null,
    wasted_steps: hasWaste ? wasted : null,
    wasted_fraction: hasWaste && judged ? wasted / judged : null,
    off_task_steps: sawOnTask ? offTask : null,
    first_off_task_step: sawOnTask ? firstOffTask : null,
    errors,
    errors_recovered: sawProgress ? recovered : null,
    error_recovery_rate: sawProgress && errors ? recovered / errors : null,
    mean_steps_to_recover: sawProgress ? mean(dists) : null,
    composites: Object.fromEntries([...compAcc].map(([k, v]) => [`${k}_mean`, mean(v)!])),
  };
}

/** Flat, JSON-friendly view for the trace-level state (nulls dropped). */
export function summaryForState(s: StepSummary): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  const put = (k: string, v: number | null) => {
    if (v !== null) out[k] = Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
  };
  put("steps_judged", s.steps_judged);
  put("progress_mean", s.progress_mean);
  put("no_progress_steps", s.no_progress_steps);
  put("longest_stall", s.longest_stall);
  put("wasted_steps", s.wasted_steps);
  put("wasted_fraction", s.wasted_fraction);
  put("off_task_steps", s.off_task_steps);
  put("first_off_task_step", s.first_off_task_step);
  put("errors", s.errors);
  put("errors_recovered", s.errors_recovered);
  put("error_recovery_rate", s.error_recovery_rate);
  put("mean_steps_to_recover", s.mean_steps_to_recover);
  for (const [k, v] of Object.entries(s.composites)) put(k, v);
  return out;
}

/** Trace-level score rows derived from the summary (kind "aggregate"). */
export function summaryScores(s: StepSummary): { name: string; value: number; comment: string }[] {
  const rows: { name: string; value: number; comment: string }[] = [];
  const add = (name: string, v: number | null, comment: string) => {
    if (v !== null) rows.push({ name, value: v, comment });
  };
  add("steps_judged", s.steps_judged, "steps graded by the per-step evaluator");
  add("progress_mean", s.progress_mean, "mean normalised progress per step (1 = every step moved the task forward)");
  add("longest_stall", s.longest_stall, "longest run of consecutive steps without progress");
  add("wasted_fraction", s.wasted_fraction, `${s.wasted_steps ?? 0} of ${s.steps_judged} steps redundant or without progress`);
  add("first_off_task_step", s.first_off_task_step, "0-based index of the first step judged off task");
  add("off_task_steps", s.off_task_steps, "steps judged off task");
  if (s.errors) add("error_recovery_rate", s.error_recovery_rate, `${s.errors_recovered ?? 0} of ${s.errors} ERROR steps were followed by progress`);
  add("mean_steps_to_recover", s.mean_steps_to_recover, "mean steps from an ERROR to the next step with progress");
  for (const [k, v] of Object.entries(s.composites)) add(k, v, "mean of the per-step composite");
  return rows;
}

/** Evenly spaced sample that always keeps the first and last element. */
export function sampleEvenly<T>(xs: T[], max: number): T[] {
  if (max <= 0 || xs.length <= max) return xs;
  if (max === 1) return [xs[0]!];
  const out: T[] = [];
  const stride = (xs.length - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(xs[Math.round(k * stride)]!);
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return out;
}
