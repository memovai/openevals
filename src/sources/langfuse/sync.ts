// Langfuse connector. Three loops, all idempotent and watermark-driven so a
// restart never loses or double-judges anything:
//   pull        v2/observations in [watermark - overlap, now - settle) → local trace snapshot → eval queue
//   write-back  EVAL scores with synced_at IS NULL → ingestion score-create events (+ review queue)
//   annotations v3/scores?source=ANNOTATION → local ANNOTATION scores (human verdict → `passed`)
// Langfuse stays the system of record for traces; the local SQLite copy exists
// so the eval engine, the judgment audit trail and the hash cache keep working.
import type { Repo, ScoreRow } from "../../db/repo.js";
import { config } from "../../config.js";
import { LangfuseClient, type IngestionEvent, type LangfuseObservationV2, type LangfuseScoreV3 } from "./client.js";
import { groupByTrace, rootOf, toObservationRow, toTraceRow } from "./map.js";

export interface SyncLogger {
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
}

export type LangfuseSyncOptions = typeof config.langfuse & {
  publicUrl?: string;
  now?: () => number;
};

const K = {
  watermark: "langfuse:watermark",
  lastPoll: "langfuse:last_poll_at",
  lastPollError: "langfuse:last_poll_error",
  obsPulled: "langfuse:observations_pulled",
  tracesPulled: "langfuse:traces_pulled",
  lastWriteBack: "langfuse:last_write_back_at",
  scoresWritten: "langfuse:scores_written",
  scoresRejected: "langfuse:scores_rejected",
  lastWriteBackError: "langfuse:last_write_back_error",
  annotationsWatermark: "langfuse:annotations_watermark",
  annotationsPulled: "langfuse:annotations_pulled",
  lastAnnotationsError: "langfuse:last_annotations_error",
  queued: "langfuse:review_queued",
} as const;

const PASS_WORDS = new Set(["pass", "passed", "true", "yes", "ok", "good", "correct", "accept", "accepted"]);

export class LangfuseSync {
  private timers: NodeJS.Timeout[] = [];
  private pulling = false;
  private writing = false;
  private annotating = false;
  private projectId: string | null = null;

  constructor(
    private repo: Repo,
    private client: LangfuseClient,
    private schedule: (traceId: string, settleMs?: number) => void,
    private opts: LangfuseSyncOptions,
    private log: SyncLogger = console,
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  private bump(key: string, by: number): void {
    this.repo.setSyncState(key, String(Number(this.repo.getSyncState(key) ?? 0) + by));
  }

  start(): void {
    if (this.timers.length) return;
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn().catch((e) => this.log.error("[langfuse]", e)), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.opts.pollMs, () => this.pollOnce());
    if (this.opts.writeBack) every(Math.max(5_000, Math.floor(this.opts.pollMs / 3)), () => this.writeBackOnce());
    every(Math.max(this.opts.pollMs, 60_000), () => this.pullAnnotationsOnce());
    void this.pollOnce().catch((e) => this.log.error("[langfuse] first poll failed", e));
  }
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  status(): Record<string, unknown> {
    const st = this.repo.listSyncState("langfuse:");
    return {
      host: this.client.host,
      project_id: this.projectId,
      poll_ms: this.opts.pollMs,
      settle_s: this.opts.settleS,
      write_back: this.opts.writeBack,
      review_queue: this.opts.reviewQueueId ?? null,
      ...Object.fromEntries(Object.entries(st).filter(([k]) => k !== "review_queued")),
      unsynced_scores: this.repo.unsyncedScores("langfuse", 100_000).length,
    };
  }

  // ------------------------------------------------------------------ pull
  /** One poll: read the settled window, upsert traces + observations, schedule evaluation. */
  async pollOnce(): Promise<{ observations: number; traces: number; pages: number; from: string; to: string } | null> {
    if (this.pulling) return null;
    this.pulling = true;
    try {
      const nowMs = this.now();
      const watermark = this.repo.getSyncState(K.watermark);
      const fromMs = watermark ? Date.parse(watermark) - this.opts.overlapS * 1000 : nowMs - this.opts.lookbackS * 1000;
      const toMs = nowMs - this.opts.settleS * 1000;
      const from = new Date(fromMs).toISOString();
      const to = new Date(toMs).toISOString();
      if (toMs <= fromMs) return { observations: 0, traces: 0, pages: 0, from, to };

      const all: LangfuseObservationV2[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let complete = true;
      do {
        const page = await this.client.listObservations({ fromStartTime: from, toStartTime: to, cursor, limit: this.opts.pageLimit, environment: this.opts.environments.length ? this.opts.environments : undefined });
        pages++;
        all.push(...page.data);
        cursor = page.meta?.cursor;
        if (all.length >= this.opts.maxPerTick && cursor) {
          complete = false;
          break;
        }
      } while (cursor);

      const groups = groupByTrace(all);
      let traces = 0;
      for (const [traceId, obs] of groups) {
        let root = rootOf(obs);
        const known = this.repo.getTrace(traceId);
        const rootMissing = !obs.some((o) => o.isRootObservation || !o.parentObservationId);
        // a long run whose root started before the window: fetch the whole trace once so task/input are known
        if (rootMissing && (!known || known.input === null || known.input === undefined)) {
          const full = await this.client.observationsOfTrace(traceId, new Date(fromMs - 7 * 24 * 3600 * 1000).toISOString());
          if (full.length) {
            obs.splice(0, obs.length, ...full);
            root = rootOf(obs);
          }
        }
        const rootName = root?.traceName ?? root?.name ?? known?.name ?? null;
        if (this.opts.traceNames.length && !(rootName && this.opts.traceNames.includes(rootName))) continue;
        this.repo.db.exec("BEGIN");
        try {
          this.repo.upsertTrace(toTraceRow(traceId, obs, { host: this.client.host, traceUrl: (p, t) => this.client.traceUrl(p, t) }));
          for (const o of obs) this.repo.upsertObservation(toObservationRow(o));
          this.repo.db.exec("COMMIT");
        } catch (e) {
          this.repo.db.exec("ROLLBACK");
          throw e;
        }
        if (root) this.projectId = root.projectId;
        this.schedule(traceId, 0); // the window is already settled
        traces++;
      }

      // advance: to the window end when every page was read, else to the last start time seen (overlap re-reads the rest)
      const maxStart = all.reduce((m, o) => Math.max(m, Date.parse(o.startTime)), 0);
      const next = complete ? toMs : Math.max(fromMs, maxStart);
      this.repo.setSyncState(K.watermark, new Date(next).toISOString());
      this.repo.setSyncState(K.lastPoll, new Date(nowMs).toISOString());
      this.repo.setSyncState(K.lastPollError, null);
      this.bump(K.obsPulled, all.length);
      this.bump(K.tracesPulled, traces);
      if (all.length) this.log.info(`[langfuse] pulled ${all.length} observations / ${traces} traces (${pages} pages${complete ? "" : ", more pending"})`);
      return { observations: all.length, traces, pages, from, to };
    } catch (e) {
      this.repo.setSyncState(K.lastPollError, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.pulling = false;
    }
  }

  // ------------------------------------------------------------ write-back
  private wantsScore(s: ScoreRow): boolean {
    if (s.observation_id && !this.opts.writeBackSteps) return false;
    if (this.opts.writeBackScores.length && !this.opts.writeBackScores.includes(s.name)) return false;
    return true;
  }

  private toEvent(s: ScoreRow): IngestionEvent {
    const meta = s.metadata ?? {};
    const judgmentUrl = this.opts.publicUrl ? `${this.opts.publicUrl}/traces/${encodeURIComponent(s.trace_id)}${s.judgment_id ? `#judgment-${s.judgment_id}` : ""}` : undefined;
    const body: Record<string, unknown> = {
      id: `oe-${s.id}`,
      traceId: s.trace_id,
      name: s.name,
      dataType: s.data_type,
      value: s.data_type === "CATEGORICAL" ? s.string_value : s.value,
      comment: s.comment ? s.comment.slice(0, 1000) : undefined,
      metadata: {
        openevals: {
          evaluator: (meta.from as string | undefined) ?? undefined,
          evaluator_id: s.evaluator_id,
          judgment_id: s.judgment_id,
          kind: meta.kind,
          model: meta.model,
          confidence: meta.confidence,
          probabilities: meta.probabilities,
          escalated: meta.escalated,
          url: judgmentUrl,
        },
      },
    };
    if (s.observation_id) body.observationId = s.observation_id;
    return { id: `oe-${s.id}`, type: "score-create", timestamp: s.timestamp, body };
  }

  /** Push pending EVAL scores to Langfuse in batches of 100; queue failed/unsure traces for human review. */
  async writeBackOnce(): Promise<{ written: number; rejected: number; queued: number } | null> {
    if (this.writing) return null;
    this.writing = true;
    try {
      const pending = this.repo.unsyncedScores("langfuse", 500);
      if (!pending.length) return { written: 0, rejected: 0, queued: 0 };
      const skip = pending.filter((s) => !this.wantsScore(s)).map((s) => s.id);
      this.repo.markScoresSynced(skip, "skipped");
      const send = pending.filter((s) => this.wantsScore(s));
      let written = 0,
        rejected = 0;
      for (let i = 0; i < send.length; i += 100) {
        const batch = send.slice(i, i + 100);
        const res = await this.client.ingest(batch.map((s) => this.toEvent(s)));
        const ok = new Set(res.successes.map((x) => x.id.replace(/^oe-/, "")));
        const bad = new Map(res.errors.map((x) => [x.id.replace(/^oe-/, ""), x]));
        this.repo.markScoresSynced(batch.filter((s) => ok.has(s.id)).map((s) => s.id));
        // 4xx rejections will not succeed on retry: mark them so the loop does not spin; keep the reason in sync_state
        const hard = batch.filter((s) => bad.has(s.id) && (bad.get(s.id)!.status ?? 500) < 500);
        this.repo.markScoresSynced(hard.map((s) => s.id), "rejected");
        written += ok.size;
        rejected += bad.size;
        if (bad.size) {
          const first = [...bad.values()][0]!;
          this.repo.setSyncState(K.lastWriteBackError, `${bad.size} rejected, e.g. ${first.status} ${first.message ?? JSON.stringify(first.error ?? "")}`.slice(0, 500));
          this.log.warn(`[langfuse] ${bad.size} scores rejected: ${first.status} ${first.message ?? ""}`);
        }
      }
      const queued = this.opts.reviewQueueId ? await this.queueForReview(send) : 0;
      this.repo.setSyncState(K.lastWriteBack, new Date(this.now()).toISOString());
      this.bump(K.scoresWritten, written);
      this.bump(K.scoresRejected, rejected);
      if (written) this.log.info(`[langfuse] wrote back ${written} scores${queued ? `, queued ${queued} traces for review` : ""}`);
      return { written, rejected, queued };
    } catch (e) {
      this.repo.setSyncState(K.lastWriteBackError, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.writing = false;
    }
  }

  /** Traces whose pass score is false or whose judgment needs review go to the configured annotation queue, once. */
  private async queueForReview(scores: ScoreRow[]): Promise<number> {
    const queueId = this.opts.reviewQueueId!;
    const queued = new Set<string>(JSON.parse(this.repo.getSyncState(K.queued) ?? "[]") as string[]);
    const candidates = new Set<string>();
    for (const s of scores) {
      if (queued.has(s.trace_id)) continue;
      if (s.metadata?.kind === "pass" && s.observation_id === null && (s.value ?? 1) < 0.5) candidates.add(s.trace_id);
    }
    for (const traceId of new Set(scores.map((s) => s.trace_id))) {
      if (queued.has(traceId) || candidates.has(traceId)) continue;
      if (this.repo.listJudgments(traceId).some((j) => j.needs_review)) candidates.add(traceId);
    }
    let n = 0;
    for (const traceId of candidates) {
      try {
        await this.client.addAnnotationQueueItem(queueId, traceId, "TRACE");
        queued.add(traceId);
        n++;
      } catch (e) {
        this.log.warn(`[langfuse] could not queue ${traceId} for review: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // keep the memory bounded: the newest 5,000 queued ids are enough to avoid double-queuing
    this.repo.setSyncState(K.queued, JSON.stringify([...queued].slice(-5000)));
    return n;
  }

  // ----------------------------------------------------------- annotations
  private verdictValue(s: LangfuseScoreV3): number | null {
    if (s.dataType === "BOOLEAN" || s.dataType === "NUMERIC") return typeof s.value === "number" ? (s.value >= 0.5 ? 1 : 0) : null;
    if (s.dataType === "CATEGORICAL" && s.stringValue) return PASS_WORDS.has(s.stringValue.toLowerCase()) ? 1 : 0;
    return null;
  }

  /** Pull human annotations (Langfuse annotation queues) into local ANNOTATION scores so calibration and backtests see them. */
  async pullAnnotationsOnce(): Promise<{ pulled: number } | null> {
    if (this.annotating) return null;
    this.annotating = true;
    try {
      const nowMs = this.now();
      const wm = this.repo.getSyncState(K.annotationsWatermark);
      const from = new Date(wm ? Date.parse(wm) - 60_000 : nowMs - this.opts.lookbackS * 1000).toISOString();
      let cursor: string | undefined;
      let pulled = 0;
      let page = 0;
      do {
        const res = await this.client.listScores({ source: "ANNOTATION", fromTimestamp: from, cursor, limit: 100 });
        for (const s of res.data) {
          const traceId = s.subject?.kind === "trace" ? s.subject.id : s.subject?.kind === "observation" ? s.subject.traceId : s.traceId;
          const observationId = s.subject?.kind === "observation" ? s.subject.id : s.observationId ?? null;
          if (!traceId || !this.repo.getTrace(traceId)) continue;
          const isVerdict = s.name === this.opts.verdictScore;
          const verdict = isVerdict ? this.verdictValue(s) : null;
          const value = isVerdict ? verdict : typeof s.value === "number" ? s.value : null;
          this.repo.upsertAnnotation({
            id: `lf-${s.id}`,
            trace_id: traceId,
            observation_id: observationId ?? null,
            name: isVerdict && verdict !== null ? "passed" : s.name,
            value,
            string_value: isVerdict && verdict !== null ? null : s.stringValue ?? null,
            data_type: isVerdict && verdict !== null ? "BOOLEAN" : s.dataType === "CATEGORICAL" ? "CATEGORICAL" : s.dataType === "BOOLEAN" ? "BOOLEAN" : "NUMERIC",
            source: "ANNOTATION",
            comment: s.comment ?? null,
            metadata: { langfuse: { id: s.id, name: s.name, authorUserId: s.authorUserId ?? null, queueId: s.queueId ?? null, configId: s.configId ?? null } },
            evaluator_id: null,
            judgment_id: null,
            timestamp: s.timestamp,
          });
          pulled++;
        }
        cursor = res.meta?.cursor;
        page++;
      } while (cursor && page < 50);
      this.repo.setSyncState(K.annotationsWatermark, new Date(nowMs).toISOString());
      this.repo.setSyncState(K.lastAnnotationsError, null);
      this.bump(K.annotationsPulled, pulled);
      if (pulled) this.log.info(`[langfuse] pulled ${pulled} annotations`);
      return { pulled };
    } catch (e) {
      this.repo.setSyncState(K.lastAnnotationsError, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.annotating = false;
    }
  }
}

export function langfuseFromEnv(repo: Repo, schedule: (traceId: string, settleMs?: number) => void, log: SyncLogger = console): LangfuseSync | null {
  const c = config.langfuse;
  if (!c.host || !c.publicKey || !c.secretKey) return null;
  const client = new LangfuseClient({ host: c.host, publicKey: c.publicKey, secretKey: c.secretKey });
  return new LangfuseSync(repo, client, schedule, { ...c, publicUrl: config.publicUrl }, log);
}
