// Convert jev answers into Langfuse-style score rows, plus an optional
// composite score and pass/fail computed in code (jev's "composite scoring"
// pattern: the model supplies atomic judgments, the weights live here).
import type { JevAnswers } from "./jev.js";
import type { ScoreRow } from "../db/repo.js";

export type Transform = "noul" | "noul_inverted" | "score_norm" | "score_norm_inverted" | "choice_is";

export interface CompositeTerm {
  q: string; // question id
  weight: number;
  transform: Transform;
  /** for choice_is: the option that counts as 1 */
  option?: string;
}
export interface PassRule {
  q: string;
  op: "<" | "<=" | ">" | ">=" | "==" | "!=";
  value: number | string;
}
export interface CompositeSpec {
  name: string; // e.g. "trajectory_quality"
  terms: CompositeTerm[];
  /** all rules must hold for `passed` = true; omitted => no `passed` score */
  pass?: PassRule[];
  passName?: string; // default "passed"
}

type Answer = JevAnswers[string];

function levels(a: Extract<Answer, { type: "score" }>): number {
  return Math.max(1, Object.keys(a.legend).length - 1);
}

function termValue(a: Answer | undefined, t: CompositeTerm): number | null {
  if (!a) return null;
  switch (t.transform) {
    case "noul":
      return a.type === "noul" ? a.noul : null;
    case "noul_inverted":
      return a.type === "noul" ? 1 - a.noul : null;
    case "score_norm":
      return a.type === "score" ? a.score / levels(a) : null;
    case "score_norm_inverted":
      return a.type === "score" ? 1 - a.score / levels(a) : null;
    case "choice_is":
      return a.type === "choice" ? (a.choice === t.option ? 1 : 0) : null;
  }
}

function rawValue(a: Answer | undefined): number | string | null {
  if (!a) return null;
  if (a.type === "noul") return a.noul;
  if (a.type === "score") return a.score;
  return a.choice;
}

function cmp(v: number | string | null, op: PassRule["op"], target: number | string): boolean {
  if (v === null) return false;
  switch (op) {
    case "<":
      return Number(v) < Number(target);
    case "<=":
      return Number(v) <= Number(target);
    case ">":
      return Number(v) > Number(target);
    case ">=":
      return Number(v) >= Number(target);
    case "==":
      return v === target || String(v) === String(target);
    case "!=":
      return !(v === target || String(v) === String(target));
  }
}

export function composite(answers: JevAnswers, spec: CompositeSpec): { value: number | null; passed: boolean | null; detail: Record<string, number | null> } {
  let num = 0,
    den = 0;
  const detail: Record<string, number | null> = {};
  for (const t of spec.terms) {
    const v = termValue(answers[t.q], t);
    detail[t.q] = v;
    if (v === null) continue;
    num += v * t.weight;
    den += t.weight;
  }
  const value = den > 0 ? num / den : null;
  const passed = spec.pass ? spec.pass.every((r) => cmp(rawValue(answers[r.q]), r.op, r.value)) : null;
  return { value, passed, detail };
}

/** Any noul answer within `band` of 0.5 — jev gives no confidence for nouls, so this is the uncertainty proxy. */
export function hasUndecidedNoul(answers: JevAnswers, band: number): boolean {
  return Object.values(answers).some((a) => a.type === "noul" && Math.abs(a.noul - 0.5) <= band);
}

/** Minimum `confidence` across choice/score answers (noul carries none). */
export function minConfidence(answers: JevAnswers): number | null {
  let m: number | null = null;
  for (const a of Object.values(answers)) {
    if (a.type === "noul") continue;
    m = m === null ? a.confidence : Math.min(m, a.confidence);
  }
  return m;
}

type NewScore = Omit<ScoreRow, "id" | "timestamp">;

export function answersToScores(
  answers: JevAnswers,
  ctx: { traceId: string; evaluatorId: string; judgmentId: string; model: string; observationId?: string | null; rationales?: Record<string, string> | null },
  spec: CompositeSpec | null,
): NewScore[] {
  const escalated = !!ctx.rationales;
  const base = { trace_id: ctx.traceId, observation_id: ctx.observationId ?? null, source: "EVAL" as const, evaluator_id: ctx.evaluatorId, judgment_id: ctx.judgmentId };
  const meta = (extra: Record<string, unknown>) => ({ model: ctx.model, ...(escalated ? { escalated: true } : {}), ...extra });
  const why = (q: string, dflt: string) => ctx.rationales?.[q] ?? dflt;
  const out: NewScore[] = [];
  for (const [q, a] of Object.entries(answers)) {
    if (a.type === "noul") {
      out.push({ ...base, name: q, value: a.noul, string_value: null, data_type: "NUMERIC", comment: why(q, `P(yes)=${a.noul.toFixed(3)}`), metadata: meta({ kind: "noul" }) });
    } else if (a.type === "score") {
      const lvl = Math.round(a.score);
      const label = (a.legend as Record<string, unknown>)[String(lvl)];
      out.push({
        ...base,
        name: q,
        value: a.score,
        string_value: null,
        data_type: "NUMERIC",
        comment: why(q, typeof label === "string" ? `≈${lvl}: ${label}` : `≈${lvl}`),
        metadata: meta({ kind: "score", confidence: a.confidence, probabilities: a.probabilities, legend: a.legend }),
      });
    } else {
      out.push({
        ...base,
        name: q,
        value: null,
        string_value: a.choice,
        data_type: "CATEGORICAL",
        comment: why(q, `P=${(a.probabilities[a.choice] ?? 0).toFixed(3)}`),
        metadata: meta({ kind: "choice", confidence: a.confidence, probabilities: a.probabilities }),
      });
    }
  }
  if (spec) {
    const c = composite(answers, spec);
    if (c.value !== null) {
      out.push({ ...base, name: spec.name, value: c.value, string_value: null, data_type: "NUMERIC", comment: "weighted composite (see metadata.detail)", metadata: meta({ kind: "composite", detail: c.detail, terms: spec.terms }) });
    }
    if (c.passed !== null) {
      out.push({ ...base, name: spec.passName ?? "passed", value: c.passed ? 1 : 0, string_value: null, data_type: "BOOLEAN", comment: `rules: ${spec.pass!.map((r) => `${r.q} ${r.op} ${r.value}`).join(" && ")}`, metadata: meta({ kind: "pass" }) });
    }
  }
  return out;
}
