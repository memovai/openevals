// Thin query layer over SQLite. Rows are stored with JSON columns as TEXT;
// the *Row types are what we hand to the rest of the app after parsing.
import { randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import { j, nowIso, pj } from "./index.js";

export type Json = unknown;

export interface TraceRow {
  id: string;
  project_id: string;
  name: string | null;
  user_id: string | null;
  session_id: string | null;
  input: Json;
  output: Json;
  expected_output: Json;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  release: string | null;
  version: string | null;
  environment: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
}

export interface ObservationRow {
  id: string;
  trace_id: string;
  parent_observation_id: string | null;
  type: string;
  name: string | null;
  start_time: string;
  end_time: string | null;
  completion_start_time: string | null;
  input: Json;
  output: Json;
  metadata: Record<string, unknown> | null;
  level: string;
  status_message: string | null;
  model: string | null;
  model_parameters: Record<string, unknown> | null;
  usage_input: number | null;
  usage_output: number | null;
  usage_total: number | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface ScoreRow {
  id: string;
  trace_id: string;
  observation_id: string | null;
  name: string;
  value: number | null;
  string_value: string | null;
  data_type: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  source: "API" | "EVAL" | "ANNOTATION";
  comment: string | null;
  metadata: Record<string, unknown> | null;
  evaluator_id: string | null;
  judgment_id: string | null;
  timestamp: string;
}

export interface EvaluatorRow {
  id: string;
  name: string;
  description: string | null;
  kind: "jev" | "code";
  target: "trace" | "observation";
  filter: EvaluatorFilter | null;
  questions: Record<string, unknown>;
  composite: unknown | null;
  enabled: boolean;
  builtin: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface EvaluatorFilter {
  names?: string[];
  tags?: string[];
  requiresExpectedOutput?: boolean;
  /** observation-target evaluators: which observation types/names to judge (e.g. ["TOOL"]) */
  observationTypes?: string[];
  observationNames?: string[];
}

export interface JudgmentRow {
  id: string;
  evaluator_id: string;
  evaluator_version: number;
  trace_id: string;
  observation_id: string | null;
  model: string | null;
  state: unknown;
  state_hash: string;
  state_meta: Record<string, unknown> | null;
  questions: Record<string, unknown>;
  answers: Record<string, unknown> | null;
  usage_input: number | null;
  usage_output: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  min_confidence: number | null;
  needs_review: boolean;
  status: "ok" | "error";
  error: string | null;
  escalated_from: string | null;
  rationales: Record<string, string> | null;
  created_at: string;
}

export interface QueueRow {
  trace_id: string;
  evaluator_id: string;
  status: string;
  attempts: number;
  not_before: string;
  last_error: string | null;
  updated_at: string;
}

type Raw = Record<string, unknown>;

function traceFromRaw(r: Raw): TraceRow {
  return {
    ...(r as unknown as TraceRow),
    input: pj(r.input),
    output: pj(r.output),
    expected_output: pj(r.expected_output),
    metadata: pj(r.metadata),
    tags: pj<string[]>(r.tags),
  };
}
function obsFromRaw(r: Raw): ObservationRow {
  return {
    ...(r as unknown as ObservationRow),
    input: pj(r.input),
    output: pj(r.output),
    metadata: pj(r.metadata),
    model_parameters: pj(r.model_parameters),
  };
}
function scoreFromRaw(r: Raw): ScoreRow {
  return { ...(r as unknown as ScoreRow), metadata: pj(r.metadata) };
}
function evaluatorFromRaw(r: Raw): EvaluatorRow {
  return {
    ...(r as unknown as EvaluatorRow),
    filter: pj(r.filter),
    questions: pj(r.questions) ?? {},
    composite: pj(r.composite),
    enabled: !!r.enabled,
    builtin: !!r.builtin,
  };
}
function judgmentFromRaw(r: Raw): JudgmentRow {
  return {
    ...(r as unknown as JudgmentRow),
    state: pj(r.state),
    state_meta: pj(r.state_meta),
    questions: pj(r.questions) ?? {},
    answers: pj(r.answers),
    rationales: pj(r.rationales),
    needs_review: !!r.needs_review,
  };
}

/** Merge semantics used by Langfuse: an update only overwrites fields it carries. */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export class Repo {
  constructor(public readonly db: DB) {}

  // ---------------- traces ----------------
  upsertTrace(t: Partial<TraceRow> & { id: string }): void {
    const now = nowIso();
    const existing = this.db.prepare("SELECT id FROM traces WHERE id = ?").get(t.id);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO traces (id, project_id, name, user_id, session_id, input, output, expected_output, metadata, tags,
             release, version, environment, timestamp, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.id,
          t.project_id ?? "default",
          t.name ?? null,
          t.user_id ?? null,
          t.session_id ?? null,
          j(t.input),
          j(t.output),
          j(t.expected_output),
          j(t.metadata),
          j(t.tags),
          t.release ?? null,
          t.version ?? null,
          t.environment ?? null,
          t.timestamp ?? now,
          now,
          now,
        );
      return;
    }
    const patch = defined({
      name: t.name,
      user_id: t.user_id,
      session_id: t.session_id,
      input: t.input === undefined ? undefined : j(t.input),
      output: t.output === undefined ? undefined : j(t.output),
      expected_output: t.expected_output === undefined ? undefined : j(t.expected_output),
      metadata: t.metadata === undefined ? undefined : j(t.metadata),
      tags: t.tags === undefined ? undefined : j(t.tags),
      release: t.release,
      version: t.version,
      environment: t.environment,
    });
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    this.db.prepare(`UPDATE traces SET ${sets} WHERE id = ?`).run(...(Object.values(patch) as never[]), now, t.id);
  }

  touchTrace(id: string): void {
    this.db.prepare("UPDATE traces SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  getTrace(id: string): TraceRow | null {
    const r = this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id) as Raw | undefined;
    return r ? traceFromRaw(r) : null;
  }

  listTraces(opts: { limit?: number; offset?: number; name?: string; sessionId?: string; tag?: string; userId?: string } = {}): TraceRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.name) {
      where.push("name = ?");
      params.push(opts.name);
    }
    if (opts.sessionId) {
      where.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.userId) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(traces.tags) WHERE json_each.value = ?)");
      params.push(opts.tag);
    }
    const sql = `SELECT * FROM traces ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(opts.limit ?? 50, 500), opts.offset ?? 0);
    return (this.db.prepare(sql).all(...(params as never[])) as Raw[]).map(traceFromRaw);
  }

  countTraces(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM traces").get() as Raw).n);
  }

  // ---------------- observations ----------------
  upsertObservation(o: Partial<ObservationRow> & { id: string; trace_id: string }): void {
    const now = nowIso();
    const existing = this.db.prepare("SELECT id FROM observations WHERE id = ?").get(o.id);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO observations (id, trace_id, parent_observation_id, type, name, start_time, end_time, completion_start_time,
             input, output, metadata, level, status_message, model, model_parameters, usage_input, usage_output, usage_total,
             cost_usd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          o.id,
          o.trace_id,
          o.parent_observation_id ?? null,
          o.type ?? "SPAN",
          o.name ?? null,
          o.start_time ?? now,
          o.end_time ?? null,
          o.completion_start_time ?? null,
          j(o.input),
          j(o.output),
          j(o.metadata),
          o.level ?? "DEFAULT",
          o.status_message ?? null,
          o.model ?? null,
          j(o.model_parameters),
          o.usage_input ?? null,
          o.usage_output ?? null,
          o.usage_total ?? null,
          o.cost_usd ?? null,
          now,
          now,
        );
      return;
    }
    const patch = defined({
      parent_observation_id: o.parent_observation_id,
      type: o.type,
      name: o.name,
      start_time: o.start_time,
      end_time: o.end_time,
      completion_start_time: o.completion_start_time,
      input: o.input === undefined ? undefined : j(o.input),
      output: o.output === undefined ? undefined : j(o.output),
      metadata: o.metadata === undefined ? undefined : j(o.metadata),
      level: o.level,
      status_message: o.status_message,
      model: o.model,
      model_parameters: o.model_parameters === undefined ? undefined : j(o.model_parameters),
      usage_input: o.usage_input,
      usage_output: o.usage_output,
      usage_total: o.usage_total,
      cost_usd: o.cost_usd,
    });
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    this.db.prepare(`UPDATE observations SET ${sets} WHERE id = ?`).run(...(Object.values(patch) as never[]), now, o.id);
  }

  listObservations(traceId: string): ObservationRow[] {
    return (
      this.db.prepare("SELECT * FROM observations WHERE trace_id = ? ORDER BY start_time ASC, created_at ASC").all(traceId) as Raw[]
    ).map(obsFromRaw);
  }

  // ---------------- scores ----------------
  insertScore(s: Omit<ScoreRow, "id" | "timestamp"> & { id?: string; timestamp?: string }): ScoreRow {
    const row: ScoreRow = { ...s, id: s.id ?? randomUUID(), timestamp: s.timestamp ?? nowIso() };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scores (id, trace_id, observation_id, name, value, string_value, data_type, source, comment, metadata,
           evaluator_id, judgment_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.trace_id,
        row.observation_id,
        row.name,
        row.value,
        row.string_value,
        row.data_type,
        row.source,
        row.comment,
        j(row.metadata),
        row.evaluator_id,
        row.judgment_id,
        row.timestamp,
      );
    return row;
  }

  deleteEvalScores(traceId: string, evaluatorId: string, observationId: string | null = null): void {
    if (observationId === null) this.db.prepare("DELETE FROM scores WHERE trace_id = ? AND evaluator_id = ? AND source = 'EVAL'").run(traceId, evaluatorId);
    else this.db.prepare("DELETE FROM scores WHERE trace_id = ? AND evaluator_id = ? AND observation_id = ? AND source = 'EVAL'").run(traceId, evaluatorId, observationId);
  }

  /** Trace-level EVAL scores of one evaluator only (keeps its observation-level scores). */
  deleteTraceLevelEvalScores(traceId: string, evaluatorId: string): void {
    this.db.prepare("DELETE FROM scores WHERE trace_id = ? AND evaluator_id = ? AND observation_id IS NULL AND source = 'EVAL'").run(traceId, evaluatorId);
  }

  listScores(traceId: string): ScoreRow[] {
    return (this.db.prepare("SELECT * FROM scores WHERE trace_id = ? ORDER BY timestamp ASC").all(traceId) as Raw[]).map(scoreFromRaw);
  }

  /** Latest scores for many traces at once (for the list page). */
  scoresForTraces(traceIds: string[]): Map<string, ScoreRow[]> {
    const out = new Map<string, ScoreRow[]>();
    if (!traceIds.length) return out;
    const marks = traceIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM scores WHERE trace_id IN (${marks}) ORDER BY timestamp ASC`).all(...traceIds) as Raw[];
    for (const r of rows.map(scoreFromRaw)) {
      const arr = out.get(r.trace_id) ?? [];
      arr.push(r);
      out.set(r.trace_id, arr);
    }
    return out;
  }

  scoreStats(): { name: string; n: number; avg: number | null }[] {
    return this.db
      .prepare(
        `SELECT name, COUNT(*) AS n, AVG(value) AS avg FROM scores WHERE data_type IN ('NUMERIC','BOOLEAN') GROUP BY name ORDER BY name`,
      )
      .all() as { name: string; n: number; avg: number | null }[];
  }

  // ---------------- evaluators ----------------
  upsertEvaluator(e: Partial<EvaluatorRow> & { name: string; questions: Record<string, unknown> }): EvaluatorRow {
    const now = nowIso();
    const existing = this.getEvaluatorByName(e.name);
    if (existing) {
      const changed = JSON.stringify(existing.questions) !== JSON.stringify(e.questions) || JSON.stringify(existing.composite ?? null) !== JSON.stringify(e.composite ?? null);
      this.db
        .prepare(
          `UPDATE evaluators SET description = ?, kind = ?, target = ?, filter = ?, questions = ?, composite = ?, enabled = ?, builtin = ?,
             version = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          e.description ?? existing.description,
          e.kind ?? existing.kind,
          e.target ?? existing.target,
          j(e.filter ?? existing.filter),
          JSON.stringify(e.questions),
          j(e.composite ?? null),
          (e.enabled ?? existing.enabled) ? 1 : 0,
          (e.builtin ?? existing.builtin) ? 1 : 0,
          changed ? existing.version + 1 : existing.version,
          now,
          existing.id,
        );
      return this.getEvaluator(existing.id)!;
    }
    const id = e.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO evaluators (id, name, description, kind, target, filter, questions, composite, enabled, builtin, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, e.name, e.description ?? null, e.kind ?? "jev", e.target ?? "trace", j(e.filter), JSON.stringify(e.questions), j(e.composite ?? null), (e.enabled ?? true) ? 1 : 0, e.builtin ? 1 : 0, now, now);
    return this.getEvaluator(id)!;
  }

  setEvaluatorEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE evaluators SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, nowIso(), id);
  }

  getEvaluator(id: string): EvaluatorRow | null {
    const r = this.db.prepare("SELECT * FROM evaluators WHERE id = ?").get(id) as Raw | undefined;
    return r ? evaluatorFromRaw(r) : null;
  }
  getEvaluatorByName(name: string): EvaluatorRow | null {
    const r = this.db.prepare("SELECT * FROM evaluators WHERE name = ?").get(name) as Raw | undefined;
    return r ? evaluatorFromRaw(r) : null;
  }
  listEvaluators(onlyEnabled = false): EvaluatorRow[] {
    const sql = `SELECT * FROM evaluators ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY builtin DESC, name ASC`;
    return (this.db.prepare(sql).all() as Raw[]).map(evaluatorFromRaw);
  }
  deleteEvaluator(id: string): void {
    this.db.prepare("DELETE FROM evaluators WHERE id = ? AND builtin = 0").run(id);
  }

  // ---------------- judgments ----------------
  insertJudgment(jd: Omit<JudgmentRow, "id" | "created_at"> & { id?: string }): JudgmentRow {
    const row: JudgmentRow = { ...jd, id: jd.id ?? randomUUID(), created_at: nowIso() };
    this.db
      .prepare(
        `INSERT INTO judgments (id, evaluator_id, evaluator_version, trace_id, observation_id, model, state, state_hash, state_meta,
           questions, answers, usage_input, usage_output, cost_usd, latency_ms, min_confidence, needs_review, status, error,
           escalated_from, rationales, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.evaluator_id,
        row.evaluator_version,
        row.trace_id,
        row.observation_id,
        row.model,
        JSON.stringify(row.state),
        row.state_hash,
        j(row.state_meta),
        JSON.stringify(row.questions),
        j(row.answers),
        row.usage_input,
        row.usage_output,
        row.cost_usd,
        row.latency_ms,
        row.min_confidence,
        row.needs_review ? 1 : 0,
        row.status,
        row.error,
        row.escalated_from,
        j(row.rationales),
        row.created_at,
      );
    return row;
  }

  getJudgment(id: string): JudgmentRow | null {
    const r = this.db.prepare("SELECT * FROM judgments WHERE id = ?").get(id) as Raw | undefined;
    return r ? judgmentFromRaw(r) : null;
  }

  /** Latest ok judgment for (trace, evaluator[, observation]). */
  latestJudgment(traceId: string, evaluatorId: string, observationId: string | null = null): JudgmentRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM judgments WHERE trace_id = ? AND evaluator_id = ? AND status = 'ok' AND (observation_id IS ? OR (? IS NULL))
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(traceId, evaluatorId, observationId, observationId) as Raw | undefined;
    return r ? judgmentFromRaw(r) : null;
  }

  findJudgmentByHash(evaluatorId: string, version: number, stateHash: string): JudgmentRow | null {
    const r = this.db
      .prepare("SELECT * FROM judgments WHERE evaluator_id = ? AND evaluator_version = ? AND state_hash = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 1")
      .get(evaluatorId, version, stateHash) as Raw | undefined;
    return r ? judgmentFromRaw(r) : null;
  }

  listJudgments(traceId: string): JudgmentRow[] {
    return (this.db.prepare("SELECT * FROM judgments WHERE trace_id = ? ORDER BY created_at DESC").all(traceId) as Raw[]).map(judgmentFromRaw);
  }

  judgmentStats(): { n: number; cost_usd: number; input_tokens: number; avg_latency_ms: number | null; needs_review: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(usage_input),0) AS input_tokens,
                AVG(latency_ms) AS avg_latency_ms, COALESCE(SUM(needs_review),0) AS needs_review FROM judgments WHERE status = 'ok'`,
      )
      .get() as Raw;
    return r as never;
  }

  // ---------------- queue ----------------
  enqueue(traceId: string, evaluatorIds: string[], notBefore: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO eval_queue (trace_id, evaluator_id, status, attempts, not_before, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(trace_id, evaluator_id) DO UPDATE SET
         status = CASE WHEN eval_queue.status = 'running' THEN 'running' ELSE 'pending' END,
         not_before = excluded.not_before, updated_at = excluded.updated_at`,
    );
    const now = nowIso();
    for (const e of evaluatorIds) stmt.run(traceId, e, notBefore, now);
  }

  claimDue(limit: number): QueueRow[] {
    const now = nowIso();
    const rows = this.db
      .prepare("SELECT * FROM eval_queue WHERE status = 'pending' AND not_before <= ? ORDER BY not_before ASC LIMIT ?")
      .all(now, limit) as unknown as QueueRow[];
    const mark = this.db.prepare("UPDATE eval_queue SET status = 'running', updated_at = ? WHERE trace_id = ? AND evaluator_id = ? AND status = 'pending'");
    const claimed: QueueRow[] = [];
    for (const r of rows) {
      const res = mark.run(now, r.trace_id, r.evaluator_id);
      if (Number(res.changes) > 0) claimed.push(r);
    }
    return claimed;
  }

  finishQueue(traceId: string, evaluatorId: string, status: "done" | "skipped"): void {
    // If new events arrived while running, the row was re-marked 'pending' by enqueue(); keep it pending.
    this.db
      .prepare("UPDATE eval_queue SET status = ?, updated_at = ? WHERE trace_id = ? AND evaluator_id = ? AND status = 'running'")
      .run(status, nowIso(), traceId, evaluatorId);
  }

  failQueue(traceId: string, evaluatorId: string, error: string, retryAt: string | null): void {
    this.db
      .prepare(
        `UPDATE eval_queue SET status = ?, attempts = attempts + 1, last_error = ?, not_before = COALESCE(?, not_before), updated_at = ?
         WHERE trace_id = ? AND evaluator_id = ?`,
      )
      .run(retryAt ? "pending" : "failed", error.slice(0, 2000), retryAt, nowIso(), traceId, evaluatorId);
  }

  /** Queue rows for this trace that belong to enabled observation-level evaluators and are not finished yet. */
  pendingObservationEvals(traceId: string): QueueRow[] {
    return this.db
      .prepare(
        `SELECT q.* FROM eval_queue q JOIN evaluators e ON e.id = q.evaluator_id
         WHERE q.trace_id = ? AND q.status IN ('pending','running') AND e.enabled = 1 AND e.target = 'observation'`,
      )
      .all(traceId) as unknown as QueueRow[];
  }

  /** Put a claimed row back to pending without counting an attempt (used to wait for per-step grading). */
  deferQueue(traceId: string, evaluatorId: string, notBefore: string): void {
    this.db
      .prepare("UPDATE eval_queue SET status = 'pending', not_before = ?, updated_at = ? WHERE trace_id = ? AND evaluator_id = ? AND status = 'running'")
      .run(notBefore, nowIso(), traceId, evaluatorId);
  }

  queueStats(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM eval_queue GROUP BY status").all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  // ---------------- datasets ----------------
  upsertDataset(d: { name: string; description?: string | null; metadata?: unknown }): { id: string; name: string } {
    const existing = this.db.prepare("SELECT id, name FROM datasets WHERE name = ?").get(d.name) as { id: string; name: string } | undefined;
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare("INSERT INTO datasets (id, name, description, metadata, created_at) VALUES (?, ?, ?, ?, ?)").run(id, d.name, d.description ?? null, j(d.metadata), nowIso());
    return { id, name: d.name };
  }
  listDatasets(): Raw[] {
    return this.db.prepare("SELECT d.*, (SELECT COUNT(*) FROM dataset_items i WHERE i.dataset_id = d.id) AS item_count FROM datasets d ORDER BY name").all() as Raw[];
  }
  getDatasetByName(name: string): Raw | null {
    return (this.db.prepare("SELECT * FROM datasets WHERE name = ?").get(name) as Raw | undefined) ?? null;
  }
  insertDatasetItem(it: { id?: string; dataset_id: string; input: unknown; expected_output: unknown; metadata?: unknown }): string {
    const id = it.id ?? randomUUID();
    this.db
      .prepare("INSERT OR REPLACE INTO dataset_items (id, dataset_id, input, expected_output, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, it.dataset_id, j(it.input), j(it.expected_output), j(it.metadata), nowIso());
    return id;
  }
  listDatasetItems(datasetId: string): Raw[] {
    return (this.db.prepare("SELECT * FROM dataset_items WHERE dataset_id = ? ORDER BY created_at").all(datasetId) as Raw[]).map((r) => ({
      ...r,
      input: pj(r.input),
      expected_output: pj(r.expected_output),
      metadata: pj(r.metadata),
    }));
  }
  getDatasetItem(id: string): Raw | null {
    const r = this.db.prepare("SELECT * FROM dataset_items WHERE id = ?").get(id) as Raw | undefined;
    return r ? { ...r, input: pj(r.input), expected_output: pj(r.expected_output), metadata: pj(r.metadata) } : null;
  }
  linkRunItem(l: { dataset_id: string; run_name: string; dataset_item_id: string; trace_id: string }): void {
    this.db
      .prepare("INSERT INTO dataset_run_items (id, dataset_id, run_name, dataset_item_id, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), l.dataset_id, l.run_name, l.dataset_item_id, l.trace_id, nowIso());
  }
  listRuns(datasetId: string): Raw[] {
    return this.db
      .prepare(
        `SELECT r.run_name, COUNT(*) AS n, MIN(r.created_at) AS started_at,
                AVG(CASE WHEN s.name = 'trajectory_quality' THEN s.value END) AS avg_quality,
                AVG(CASE WHEN s.name = 'passed' THEN s.value END) AS pass_rate
         FROM dataset_run_items r LEFT JOIN scores s ON s.trace_id = r.trace_id AND s.source = 'EVAL'
         WHERE r.dataset_id = ? GROUP BY r.run_name ORDER BY started_at DESC`,
      )
      .all(datasetId) as Raw[];
  }
  /** Every (item, trace) in a run with that trace's EVAL/ANNOTATION scores — the input for pass@k / pass^k. */
  runTrials(datasetId: string, runName: string): { dataset_item_id: string; trace_id: string; created_at: string; scores: ScoreRow[] }[] {
    const items = this.listRunItems(datasetId, runName) as { dataset_item_id: string; trace_id: string; created_at: string }[];
    const scores = this.scoresForTraces(items.map((i) => i.trace_id));
    return items.map((i) => ({ ...i, scores: scores.get(i.trace_id) ?? [] }));
  }

  /** Traces where a model grader and a human disagree, or that are flagged for review. */
  reviewQueue(limit = 100): { trace: TraceRow; reasons: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM traces t
         WHERE EXISTS (SELECT 1 FROM judgments jd WHERE jd.trace_id = t.id AND jd.needs_review = 1)
            OR EXISTS (SELECT 1 FROM scores s WHERE s.trace_id = t.id AND s.source = 'EVAL' AND s.data_type = 'BOOLEAN' AND s.value = 0
                         AND json_extract(s.metadata, '$.kind') = 'pass')
            OR EXISTS (SELECT 1 FROM judgments jd WHERE jd.trace_id = t.id AND jd.status = 'error')
         ORDER BY t.timestamp DESC LIMIT ?`,
      )
      .all(limit) as Raw[];
    return rows.map(traceFromRaw).map((trace) => {
      const reasons: string[] = [];
      const jd = this.listJudgments(trace.id);
      if (jd.some((x) => x.needs_review)) reasons.push("low confidence");
      if (jd.some((x) => x.status === "error")) reasons.push("grader error");
      const sc = this.listScores(trace.id);
      if (sc.some((x) => x.source === "EVAL" && x.data_type === "BOOLEAN" && x.value === 0 && x.metadata?.kind === "pass")) reasons.push("failed");
      if (sc.some((x) => x.source === "ANNOTATION")) reasons.push("annotated");
      return { trace, reasons };
    });
  }

  /** All (trace, name) pairs that carry both an EVAL and an ANNOTATION score — grader calibration data. */
  calibrationPairs(): { trace_id: string; name: string; eval_value: number | null; eval_str: string | null; human_value: number | null; human_str: string | null; data_type: string }[] {
    return this.db
      .prepare(
        `SELECT e.trace_id, e.name, e.value AS eval_value, e.string_value AS eval_str, h.value AS human_value, h.string_value AS human_str, e.data_type
         FROM scores e JOIN scores h ON h.trace_id = e.trace_id AND h.name = e.name AND h.source = 'ANNOTATION'
         WHERE e.source = 'EVAL' AND e.observation_id IS NULL AND h.observation_id IS NULL`,
      )
      .all() as never;
  }

  /** Every trace-level EVAL score from a jev/escalated judgment, with the evaluator name and the human `passed` verdict on the same trace (if any). */
  questionScoreRows(opts: { evaluator?: string; traceIds?: string[] } = {}): { trace_id: string; evaluator: string; name: string; value: number | null; string_value: string | null; metadata: Record<string, unknown> | null; human: number | null }[] {
    const where: string[] = ["s.source = 'EVAL'", "s.observation_id IS NULL", "s.evaluator_id IS NOT NULL", "json_extract(s.metadata, '$.kind') IN ('noul','score','choice')"];
    const args: unknown[] = [];
    if (opts.evaluator) {
      where.push("e.name = ?");
      args.push(opts.evaluator);
    }
    if (opts.traceIds) {
      if (!opts.traceIds.length) return [];
      where.push(`s.trace_id IN (${opts.traceIds.map(() => "?").join(",")})`);
      args.push(...opts.traceIds);
    }
    const rows = this.db
      .prepare(
        `SELECT s.trace_id, e.name AS evaluator, s.name, s.value, s.string_value, s.metadata,
                (SELECT h.value FROM scores h WHERE h.trace_id = s.trace_id AND h.source = 'ANNOTATION' AND h.name = 'passed' AND h.observation_id IS NULL ORDER BY h.timestamp DESC LIMIT 1) AS human
         FROM scores s JOIN evaluators e ON e.id = s.evaluator_id
         WHERE ${where.join(" AND ")}`,
      )
      .all(...(args as never[])) as Raw[];
    return rows.map((r) => ({
      trace_id: String(r.trace_id),
      evaluator: String(r.evaluator),
      name: String(r.name),
      value: r.value === null ? null : Number(r.value),
      string_value: r.string_value === null ? null : String(r.string_value),
      metadata: pj<Record<string, unknown>>(r.metadata),
      human: r.human === null || r.human === undefined ? null : Number(r.human),
    }));
  }

  /** Traces with a human `passed` verdict, newest first — the labeled set for backtesting an evaluator. */
  annotatedTraceIds(limit = 50): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT s.trace_id FROM scores s JOIN traces t ON t.id = s.trace_id
           WHERE s.source = 'ANNOTATION' AND s.name = 'passed' AND s.observation_id IS NULL ORDER BY t.timestamp DESC LIMIT ?`,
        )
        .all(limit) as { trace_id: string }[]
    ).map((r) => r.trace_id);
  }

  listRunItems(datasetId: string, runName: string): Raw[] {
    return this.db.prepare("SELECT * FROM dataset_run_items WHERE dataset_id = ? AND run_name = ? ORDER BY created_at").all(datasetId, runName) as Raw[];
  }
}
