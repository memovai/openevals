// In-process eval worker. Traces are enqueued at ingest time with a settle
// delay; once due, each (trace, evaluator) pair is judged by jev — one request
// per trace for trace-level evaluators, one per matching observation for
// observation-level ones. Judgments are cached by state hash, so re-ingesting
// identical data never costs a second call. Low-confidence judgments are
// escalated to a reasoning model when one is configured.
import { config } from "../config.js";
import type { Repo, EvaluatorRow, TraceRow, ObservationRow, JudgmentRow } from "../db/repo.js";
import { buildTraceState, buildObservationState, hashState, type StateMeta } from "./state.js";
import { answersToScores, hasUndecidedNoul, minConfidence, type CompositeSpec } from "./aggregate.js";
import { costUsd, type Judge } from "./jev.js";
import type { Escalator } from "./escalate.js";
import type { Questions } from "@typesafe-ai/sdk";
import { runCodeChecks, type CodeCheck } from "./code.js";

export interface WorkerLogger {
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
}

export function evaluatorApplies(ev: EvaluatorRow, trace: TraceRow): boolean {
  const f = ev.filter;
  if (!f) return true;
  if (f.requiresExpectedOutput && (trace.expected_output === null || trace.expected_output === undefined)) return false;
  if (f.names?.length && !(trace.name && f.names.includes(trace.name))) return false;
  if (f.tags?.length) {
    const tags = trace.tags ?? [];
    if (!f.tags.some((t) => tags.includes(t))) return false;
  }
  return true;
}

export function observationMatches(ev: EvaluatorRow, o: ObservationRow): boolean {
  const f = ev.filter;
  if (!f) return true;
  if (f.observationTypes?.length && !f.observationTypes.map((t) => t.toUpperCase()).includes(o.type.toUpperCase())) return false;
  if (f.observationNames?.length && !(o.name && f.observationNames.includes(o.name))) return false;
  return true;
}

/** Drop questions that reference `expected_output` when the trace has none (defensive; builtin uses filter). */
function applicableQuestions(ev: EvaluatorRow, trace: TraceRow): Questions {
  const qs = ev.questions as Questions;
  if (trace.expected_output !== null && trace.expected_output !== undefined) return qs;
  const out: Questions = {};
  for (const [k, q] of Object.entries(qs)) {
    if (JSON.stringify(q).includes("`expected_output`")) continue;
    out[k] = q;
  }
  return out;
}

export interface EvalOutcome {
  status: "judged" | "cached" | "skipped" | "error";
  judgmentId?: string;
  reason?: string;
  costUsd?: number;
  latencyMs?: number;
  escalated?: boolean;
  /** observation-level: per-observation outcomes */
  items?: Record<string, EvalOutcome>;
}

export interface Judges {
  /** null → only code graders run; jev evaluators are not scheduled */
  judge: Judge | null;
  escalator?: Escalator | null;
}

interface Unit {
  trace: TraceRow;
  observationId: string | null;
  state: unknown;
  meta: StateMeta;
  questions: Questions;
}

function writeScores(repo: Repo, unit: Unit, ev: EvaluatorRow, judgment: JudgmentRow, model: string, rationales: Record<string, string> | null): void {
  const scores = answersToScores(
    judgment.answers as never,
    { traceId: unit.trace.id, evaluatorId: ev.id, judgmentId: judgment.id, model, observationId: unit.observationId, rationales },
    ev.composite as CompositeSpec | null,
  );
  repo.db.exec("BEGIN");
  try {
    repo.deleteEvalScores(unit.trace.id, ev.id, unit.observationId);
    for (const s of scores) repo.insertScore(s);
    repo.db.exec("COMMIT");
  } catch (e) {
    repo.db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Cache hit handling. Same trace+unit → nothing to do. A different trace with identical
 * state (re-runs of a deterministic agent, duplicate imports) → reuse the answers at zero
 * cost, but materialise a judgment + scores for THIS trace so it is graded too.
 */
function reuseCached(repo: Repo, cached: JudgmentRow, unit: Unit, ev: EvaluatorRow): EvalOutcome {
  if (cached.trace_id === unit.trace.id && (cached.observation_id ?? null) === (unit.observationId ?? null)) {
    return { status: "cached", judgmentId: cached.id, costUsd: 0 };
  }
  const clone = repo.insertJudgment({
    evaluator_id: ev.id,
    evaluator_version: ev.version,
    trace_id: unit.trace.id,
    observation_id: unit.observationId,
    model: cached.model,
    state: unit.state,
    state_hash: cached.state_hash,
    state_meta: { ...(unit.meta as unknown as Record<string, unknown>), cached_from: cached.id },
    questions: unit.questions as Record<string, unknown>,
    answers: cached.answers,
    usage_input: 0,
    usage_output: 0,
    cost_usd: 0,
    latency_ms: 0,
    min_confidence: cached.min_confidence,
    needs_review: cached.needs_review,
    status: "ok",
    error: null,
    escalated_from: null,
    rationales: cached.rationales,
  });
  writeScores(repo, unit, ev, clone, cached.model ?? "cached", cached.rationales);
  return { status: "cached", judgmentId: clone.id, costUsd: 0 };
}

function needsEscalation(minConf: number | null, answers: Record<string, unknown>): boolean {
  if (minConf !== null && minConf < config.reviewConfidence) return true;
  return hasUndecidedNoul(answers as never, config.escalateNoulBand);
}

/** Second opinion from a reasoning model; replaces the jev scores for this unit. */
export async function escalateJudgment(repo: Repo, escalator: Escalator, ev: EvaluatorRow, from: JudgmentRow): Promise<EvalOutcome> {
  const trace = repo.getTrace(from.trace_id);
  if (!trace) return { status: "skipped", reason: "trace not found" };
  const unit: Unit = { trace, observationId: from.observation_id, state: from.state, meta: (from.state_meta ?? {}) as unknown as StateMeta, questions: from.questions as Questions };
  try {
    const res = await escalator.escalate(unit.state, unit.questions);
    const judgment = repo.insertJudgment({
      evaluator_id: ev.id,
      evaluator_version: ev.version,
      trace_id: trace.id,
      observation_id: unit.observationId,
      model: res.model,
      state: unit.state,
      state_hash: from.state_hash,
      state_meta: from.state_meta,
      questions: unit.questions as Record<string, unknown>,
      answers: res.answers as unknown as Record<string, unknown>,
      usage_input: res.usage.input_tokens,
      usage_output: res.usage.output_tokens,
      cost_usd: res.costUsd,
      latency_ms: res.latencyMs,
      min_confidence: null,
      needs_review: false,
      status: "ok",
      error: null,
      escalated_from: from.id,
      rationales: res.rationales,
    });
    writeScores(repo, unit, ev, judgment, res.model, res.rationales);
    return { status: "judged", judgmentId: judgment.id, costUsd: res.costUsd, latencyMs: res.latencyMs, escalated: true };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    repo.insertJudgment({
      evaluator_id: ev.id,
      evaluator_version: ev.version,
      trace_id: trace.id,
      observation_id: unit.observationId,
      model: escalator.model,
      state: unit.state,
      state_hash: from.state_hash,
      state_meta: from.state_meta,
      questions: unit.questions as Record<string, unknown>,
      answers: null,
      usage_input: null,
      usage_output: null,
      cost_usd: null,
      latency_ms: null,
      min_confidence: null,
      needs_review: true,
      status: "error",
      error: msg,
      escalated_from: from.id,
      rationales: null,
    });
    return { status: "error", reason: msg, escalated: true };
  }
}

async function judgeUnit(repo: Repo, judges: Judges, ev: EvaluatorRow, unit: Unit, opts: { force?: boolean }): Promise<EvalOutcome> {
  const stateHash = hashState({ state: unit.state, questions: unit.questions, observationId: unit.observationId });
  if (!opts.force) {
    const cached = repo.findJudgmentByHash(ev.id, ev.version, stateHash);
    if (cached) return reuseCached(repo, cached, unit, ev);
  }
  if (!judges.judge) return { status: "skipped", reason: "no judge configured (TYPESAFE_API_KEY)" };
  try {
    const res = await judges.judge.judge(unit.state, unit.questions);
    const minConf = minConfidence(res.answers);
    const cost = costUsd(res.usage.input_tokens);
    const wantsEscalation = needsEscalation(minConf, res.answers as never);
    const judgment = repo.insertJudgment({
      evaluator_id: ev.id,
      evaluator_version: ev.version,
      trace_id: unit.trace.id,
      observation_id: unit.observationId,
      model: res.model,
      state: unit.state,
      state_hash: stateHash,
      state_meta: unit.meta as unknown as Record<string, unknown>,
      questions: unit.questions as Record<string, unknown>,
      answers: res.answers as unknown as Record<string, unknown>,
      usage_input: res.usage.input_tokens,
      usage_output: res.usage.output_tokens,
      cost_usd: cost,
      latency_ms: res.latencyMs,
      min_confidence: minConf,
      needs_review: wantsEscalation,
      status: "ok",
      error: null,
      escalated_from: null,
      rationales: null,
    });
    writeScores(repo, unit, ev, judgment, res.model, null);
    const out: EvalOutcome = { status: "judged", judgmentId: judgment.id, costUsd: cost, latencyMs: res.latencyMs };
    if (wantsEscalation && judges.escalator) {
      const esc = await escalateJudgment(repo, judges.escalator, ev, judgment);
      if (esc.status === "judged") {
        repo.db.prepare("UPDATE judgments SET needs_review = 0 WHERE id = ?").run(judgment.id);
        out.escalated = true;
        out.judgmentId = esc.judgmentId;
        out.costUsd = (out.costUsd ?? 0) + (esc.costUsd ?? 0);
      }
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    repo.insertJudgment({
      evaluator_id: ev.id,
      evaluator_version: ev.version,
      trace_id: unit.trace.id,
      observation_id: unit.observationId,
      model: judges.judge?.model ?? "jev",
      state: unit.state,
      state_hash: stateHash,
      state_meta: unit.meta as unknown as Record<string, unknown>,
      questions: unit.questions as Record<string, unknown>,
      answers: null,
      usage_input: null,
      usage_output: null,
      cost_usd: null,
      latency_ms: null,
      min_confidence: null,
      needs_review: false,
      status: "error",
      error: msg,
      escalated_from: null,
      rationales: null,
    });
    return { status: "error", reason: msg };
  }
}

/** Deterministic checks: free, no model call. Each check becomes a BOOLEAN score; plus `<name>_score` (fraction passed) and `passed`. */
export function evaluateWithCode(repo: Repo, ev: EvaluatorRow, trace: TraceRow, observations: ObservationRow[], opts: { force?: boolean } = {}): EvalOutcome {
  const checks = ((ev.questions as { checks?: CodeCheck[] }).checks ?? []) as CodeCheck[];
  if (!checks.length) return { status: "skipped", reason: "no checks" };
  const { results, features } = runCodeChecks(trace, observations, checks);
  // Code checks are free, so the cache only serves to avoid duplicate judgment rows for the same trace.
  const stateHash = hashState({ features, checks, output: trace.output, expected: trace.expected_output });
  if (!opts.force) {
    const cached = repo.findJudgmentByHash(ev.id, ev.version, stateHash);
    if (cached && cached.trace_id === trace.id) return { status: "cached", judgmentId: cached.id, costUsd: 0 };
  }
  const judgment = repo.insertJudgment({
    evaluator_id: ev.id,
    evaluator_version: ev.version,
    trace_id: trace.id,
    observation_id: null,
    model: "code",
    state: features,
    state_hash: stateHash,
    state_meta: null,
    questions: { checks } as unknown as Record<string, unknown>,
    answers: Object.fromEntries(results.map((r) => [r.name, r])),
    usage_input: 0,
    usage_output: 0,
    cost_usd: 0,
    latency_ms: 0,
    min_confidence: null,
    needs_review: false,
    status: "ok",
    error: null,
    escalated_from: null,
    rationales: null,
  });
  const base = { trace_id: trace.id, observation_id: null, source: "EVAL" as const, evaluator_id: ev.id, judgment_id: judgment.id };
  const passedAll = results.every((r) => r.passed);
  const frac = results.filter((r) => r.passed).length / results.length;
  repo.db.exec("BEGIN");
  try {
    repo.deleteEvalScores(trace.id, ev.id, null);
    for (const r of results) {
      repo.insertScore({ ...base, name: r.name, value: r.passed ? 1 : 0, string_value: null, data_type: "BOOLEAN", comment: r.detail, metadata: { model: "code", kind: "check", type: r.type, ...(r.value !== undefined ? { measured: r.value } : {}) } });
    }
    repo.insertScore({ ...base, name: `${ev.name}_score`, value: frac, string_value: null, data_type: "NUMERIC", comment: `${results.filter((r) => r.passed).length}/${results.length} checks passed`, metadata: { model: "code", kind: "composite" } });
    repo.insertScore({ ...base, name: (ev.composite as { passName?: string } | null)?.passName ?? "passed", value: passedAll ? 1 : 0, string_value: null, data_type: "BOOLEAN", comment: passedAll ? "all checks passed" : `failed: ${results.filter((r) => !r.passed).map((r) => r.name).join(", ")}`, metadata: { model: "code", kind: "pass" } });
    repo.db.exec("COMMIT");
  } catch (e) {
    repo.db.exec("ROLLBACK");
    throw e;
  }
  return { status: "judged", judgmentId: judgment.id, costUsd: 0, latencyMs: 0 };
}

export async function evaluateTrace(repo: Repo, judges: Judges | Judge, ev: EvaluatorRow, traceId: string, opts: { force?: boolean } = {}): Promise<EvalOutcome> {
  const J: Judges = "judge" in judges && typeof (judges as Judges).judge === "object" ? (judges as Judges) : { judge: judges as Judge };
  const trace = repo.getTrace(traceId);
  if (!trace) return { status: "skipped", reason: "trace not found" };
  if (!evaluatorApplies(ev, trace)) return { status: "skipped", reason: "filter" };
  const observations = repo.listObservations(traceId);
  if (ev.kind === "code") return evaluateWithCode(repo, ev, trace, observations, opts);
  const questions = applicableQuestions(ev, trace);
  if (!Object.keys(questions).length) return { status: "skipped", reason: "no applicable questions" };

  if (ev.target === "observation") {
    const targets = observations.filter((o) => observationMatches(ev, o));
    if (!targets.length) return { status: "skipped", reason: "no matching observations" };
    const items: Record<string, EvalOutcome> = {};
    let cost = 0,
      judged = 0,
      errors = 0;
    for (const o of targets) {
      const { state, meta } = buildObservationState(trace, observations, o, config.stateBudgetChars);
      const r = await judgeUnit(repo, J, ev, { trace, observationId: o.id, state, meta, questions }, opts);
      items[o.id] = r;
      cost += r.costUsd ?? 0;
      if (r.status === "judged") judged++;
      if (r.status === "error") errors++;
    }
    if (errors && errors === targets.length) return { status: "error", reason: `all ${errors} observations failed`, items };
    return { status: judged ? "judged" : "cached", costUsd: cost, items };
  }

  if (!observations.length && (trace.output === null || trace.output === undefined)) return { status: "skipped", reason: "empty trace" };
  const { state, meta } = buildTraceState(trace, observations, config.stateBudgetChars);
  return judgeUnit(repo, J, ev, { trace, observationId: null, state, meta, questions }, opts);
}

export class EvalWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(
    private repo: Repo,
    private judges: Judges,
    private log: WorkerLogger = console,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config.workerTickMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let processed = 0;
    try {
      const due = this.repo.claimDue(config.workerBatch);
      await Promise.all(
        due.map(async (row) => {
          const ev = this.repo.getEvaluator(row.evaluator_id);
          if (!ev || !ev.enabled) {
            this.repo.finishQueue(row.trace_id, row.evaluator_id, "skipped");
            return;
          }
          const out = await evaluateTrace(this.repo, this.judges, ev, row.trace_id);
          processed++;
          if (out.status === "error") {
            const attempts = row.attempts + 1;
            const retryAt = attempts < config.maxAttempts ? new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1000)).toISOString() : null;
            this.repo.failQueue(row.trace_id, row.evaluator_id, out.reason ?? "error", retryAt);
            this.log.warn(`[eval] ${ev.name} trace=${row.trace_id} failed (attempt ${attempts}): ${out.reason}`);
          } else {
            this.repo.finishQueue(row.trace_id, row.evaluator_id, out.status === "skipped" ? "skipped" : "done");
            if (out.status === "judged") this.log.info(`[eval] ${ev.name} trace=${row.trace_id} judged${out.escalated ? " (escalated)" : ""} $${out.costUsd?.toFixed(6)}`);
          }
        }),
      );
    } catch (e) {
      this.log.error("[eval] tick failed", e);
    } finally {
      this.busy = false;
    }
    return processed;
  }
}

/** Called by ingestion: schedule every enabled, runnable evaluator for this trace after the settle delay. */
export function scheduleTrace(repo: Repo, traceId: string, settleMs = config.settleMs, opts: { hasJudge?: boolean } = {}): void {
  const hasJudge = opts.hasJudge ?? true;
  const evs = repo.listEvaluators(true).filter((e) => e.kind === "code" || hasJudge);
  if (!evs.length) return;
  repo.enqueue(
    traceId,
    evs.map((e) => e.id),
    new Date(Date.now() + settleMs).toISOString(),
  );
}

export function ensureBuiltins(
  repo: Repo,
  builtins: { name: string; description: string; kind?: "jev" | "code"; target?: "trace" | "observation"; filter: unknown; questions: Record<string, unknown>; composite: unknown; enabledByDefault?: boolean }[],
): void {
  for (const b of builtins) {
    const existing = repo.getEvaluatorByName(b.name);
    repo.upsertEvaluator({
      name: b.name,
      description: b.description,
      kind: b.kind ?? "jev",
      target: b.target ?? "trace",
      filter: b.filter as never,
      questions: b.questions,
      composite: b.composite,
      builtin: true,
      enabled: existing ? existing.enabled : b.enabledByDefault ?? true,
    });
  }
}
