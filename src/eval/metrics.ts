// Run-level metrics from Anthropic's eval guide: pass@k, pass^k, per-item
// pass rates (0/k across many trials flags a probably-broken task), and
// regression detection between two runs. Also grader calibration: how well
// model scores agree with human annotations on the same traces.
import type { ScoreRow } from "../db/repo.js";

export interface Trial {
  dataset_item_id: string;
  trace_id: string;
  scores: ScoreRow[];
}

export interface ItemReport {
  item_id: string;
  trials: number;
  passes: number;
  pass_rate: number | null;
  /** 0 passes across ≥3 trials: per the guide, most often a broken task, not an incapable agent */
  suspect_broken: boolean;
  trace_ids: string[];
  avg: Record<string, number | null>;
}

export interface RunReport {
  run: string;
  items: number;
  trials: number;
  trials_per_item: number;
  pass_score: string;
  /** mean per-trial success */
  pass_at_1: number | null;
  /** P(at least one of k trials passes), averaged over items, k = min trials per item */
  pass_at_k: number | null;
  /** P(all k trials pass), averaged over items */
  pass_pow_k: number | null;
  k: number;
  avg: Record<string, number | null>;
  per_item: ItemReport[];
}

function passedOf(scores: ScoreRow[], passScore: string): boolean | null {
  const s = scores.filter((x) => x.source === "EVAL" && x.name === passScore && x.observation_id === null);
  if (!s.length) return null;
  // all pass-type scores for this trace must be true (e.g. `passed` from several code evaluators)
  return s.every((x) => (x.value ?? 0) >= 0.5);
}

function meanBy(scores: ScoreRow[]): Record<string, number | null> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const s of scores) {
    if (s.source !== "EVAL" || s.observation_id !== null || s.value === null) continue;
    if (s.data_type === "CATEGORICAL") continue;
    const a = acc.get(s.name) ?? { sum: 0, n: 0 };
    a.sum += s.value;
    a.n++;
    acc.set(s.name, a);
  }
  return Object.fromEntries([...acc].map(([k, v]) => [k, v.n ? v.sum / v.n : null]));
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function runReport(run: string, trials: Trial[], passScore = "passed"): RunReport {
  const byItem = new Map<string, Trial[]>();
  for (const t of trials) byItem.set(t.dataset_item_id, [...(byItem.get(t.dataset_item_id) ?? []), t]);
  const per_item: ItemReport[] = [];
  const perTrial: number[] = [];
  const anyK: number[] = [];
  const allK: number[] = [];
  const kCandidates: number[] = [];
  for (const [item_id, ts] of byItem) {
    const verdicts = ts.map((t) => passedOf(t.scores, passScore)).filter((v): v is boolean => v !== null);
    const passes = verdicts.filter(Boolean).length;
    const n = verdicts.length;
    if (n) {
      kCandidates.push(n);
      perTrial.push(passes / n);
      anyK.push(passes > 0 ? 1 : 0);
      allK.push(passes === n ? 1 : 0);
    }
    per_item.push({
      item_id,
      trials: ts.length,
      passes,
      pass_rate: n ? passes / n : null,
      suspect_broken: n >= 3 && passes === 0,
      trace_ids: ts.map((t) => t.trace_id),
      avg: meanBy(ts.flatMap((t) => t.scores)),
    });
  }
  const k = kCandidates.length ? Math.min(...kCandidates) : 0;
  return {
    run,
    items: byItem.size,
    trials: trials.length,
    trials_per_item: byItem.size ? trials.length / byItem.size : 0,
    pass_score: passScore,
    pass_at_1: mean(perTrial),
    pass_at_k: k > 0 ? mean(anyK) : null,
    pass_pow_k: k > 0 ? mean(allK) : null,
    k,
    avg: meanBy(trials.flatMap((t) => t.scores)),
    per_item: per_item.sort((a, b) => (a.pass_rate ?? 2) - (b.pass_rate ?? 2)),
  };
}

/** Items that passed every trial in `base` but not in `candidate` (regressions), and the reverse (fixes). */
export function compareRuns(base: RunReport, candidate: RunReport): { regressions: string[]; fixes: string[]; unchanged: number; only_in_base: string[]; only_in_candidate: string[] } {
  const b = new Map(base.per_item.map((i) => [i.item_id, i]));
  const c = new Map(candidate.per_item.map((i) => [i.item_id, i]));
  const regressions: string[] = [],
    fixes: string[] = [];
  let unchanged = 0;
  for (const [id, bi] of b) {
    const ci = c.get(id);
    if (!ci || bi.pass_rate === null || ci.pass_rate === null) continue;
    if (bi.pass_rate === 1 && ci.pass_rate < 1) regressions.push(id);
    else if (bi.pass_rate < 1 && ci.pass_rate === 1) fixes.push(id);
    else unchanged++;
  }
  return {
    regressions,
    fixes,
    unchanged,
    only_in_base: [...b.keys()].filter((id) => !c.has(id)),
    only_in_candidate: [...c.keys()].filter((id) => !b.has(id)),
  };
}

// ---------------- calibration ----------------
export interface CalibrationPair {
  trace_id: string;
  name: string;
  eval_value: number | null;
  eval_str: string | null;
  human_value: number | null;
  human_str: string | null;
  data_type: string;
}
export interface CalibrationRow {
  name: string;
  n: number;
  /** for BOOLEAN/CATEGORICAL: fraction where grader == human (numeric graders thresholded at 0.5 when the human gave a boolean) */
  agreement: number | null;
  /** Cohen's kappa for boolean agreement (chance-corrected); null when undefined */
  kappa: number | null;
  /** for NUMERIC pairs: mean absolute error and Pearson r */
  mae: number | null;
  pearson_r: number | null;
  /** grader said pass, human said fail — the dangerous direction */
  false_pass: number;
  false_fail: number;
}

export function calibration(pairs: CalibrationPair[]): CalibrationRow[] {
  const byName = new Map<string, CalibrationPair[]>();
  for (const p of pairs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  const rows: CalibrationRow[] = [];
  for (const [name, ps] of byName) {
    let agree = 0,
      nBool = 0,
      fp = 0,
      fn = 0,
      a = 0, // grader yes & human yes
      b = 0, // grader yes & human no
      c = 0, // grader no & human yes
      d = 0; // grader no & human no
    const xs: number[] = [],
      ys: number[] = [];
    for (const p of ps) {
      if (p.eval_str !== null || p.human_str !== null) {
        // categorical
        nBool++;
        if ((p.eval_str ?? String(p.eval_value)) === (p.human_str ?? String(p.human_value))) agree++;
        continue;
      }
      if (p.eval_value === null || p.human_value === null) continue;
      const humanIsBool = p.human_value === 0 || p.human_value === 1;
      if (p.data_type === "BOOLEAN" || humanIsBool) {
        const g = p.eval_value >= 0.5,
          h = p.human_value >= 0.5;
        nBool++;
        if (g === h) agree++;
        if (g && !h) (fp++, b++);
        else if (!g && h) (fn++, c++);
        else if (g && h) a++;
        else d++;
      }
      xs.push(p.eval_value);
      ys.push(p.human_value);
    }
    let kappa: number | null = null;
    const N = a + b + c + d;
    if (N > 0) {
      const po = (a + d) / N;
      const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (N * N);
      kappa = pe === 1 ? null : (po - pe) / (1 - pe);
    }
    let mae: number | null = null,
      r: number | null = null;
    if (xs.length) {
      mae = mean(xs.map((x, i) => Math.abs(x - ys[i]!)));
      const mx = mean(xs)!,
        my = mean(ys)!;
      const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
      const vx = xs.reduce((s, x) => s + (x - mx) ** 2, 0),
        vy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
      r = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
    }
    rows.push({ name, n: ps.length, agreement: nBool ? agree / nBool : null, kappa, mae, pearson_r: r, false_pass: fp, false_fail: fn });
  }
  return rows.sort((x, y) => x.name.localeCompare(y.name));
}
