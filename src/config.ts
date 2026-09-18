// Runtime configuration. Everything comes from env so a single binary/process
// can be pointed at any SQLite file and any TypeSafe key.

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}
function num(v: string | undefined, dflt: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  port: num(process.env.OPENEVALS_PORT, 3100),
  dbPath: process.env.OPENEVALS_DB ?? "./data/openevals.db",
  apiKey: process.env.OPENEVALS_API_KEY || undefined,

  typesafeApiKey: process.env.TYPESAFE_API_KEY || undefined,
  jevModel: process.env.OPENEVALS_JEV_MODEL ?? "jev-latest",
  // Published price for jev-1.13: $42 per billion input tokens; output tokens are free.
  jevUsdPerInputToken: 42 / 1e9,

  evalEnabled: bool(process.env.OPENEVALS_EVAL_ENABLED, true),
  settleMs: num(process.env.OPENEVALS_SETTLE_MS, 5000),
  stateBudgetChars: num(process.env.OPENEVALS_STATE_BUDGET_CHARS, 90_000),
  reviewConfidence: num(process.env.OPENEVALS_REVIEW_CONFIDENCE, 0.5),

  // Escalate low-confidence jev judgments to a reasoning model (needs ANTHROPIC_API_KEY).
  escalateEnabled: bool(process.env.OPENEVALS_ESCALATE, true),
  escalateModel: process.env.OPENEVALS_ESCALATE_MODEL ?? "claude-opus-5",
  /** also escalate when any noul answer sits in [0.5-x, 0.5+x] (jev gives no confidence for nouls) */
  escalateNoulBand: num(process.env.OPENEVALS_ESCALATE_NOUL_BAND, 0.15),
  workerTickMs: 1000,
  workerBatch: 8,
  maxAttempts: 5,

  // Per-step (observation-level) grading. jev is ~100 ms per request, so steps of one trace
  // are judged concurrently; very long runs are sampled down to `stepMaxPerTrace` steps.
  stepConcurrency: num(process.env.OPENEVALS_STEP_CONCURRENCY, 8),
  stepMaxPerTrace: num(process.env.OPENEVALS_STEP_MAX, 150),
  /** how many previous steps a per-step state carries (with clipped input/output) */
  stepContextWindow: num(process.env.OPENEVALS_STEP_CONTEXT, 8),
  /** trace-level jev evaluators wait for per-step ones so their answers can be folded into the state */
  stepWaitMs: num(process.env.OPENEVALS_STEP_WAIT_MS, 2000),

  // jev request budget. Published limits are 1,200 requests/min and 250k tokens/s; stay under them across
  // all evaluators, and optionally cap daily spend (jev evaluators are skipped once it is hit).
  jevRpm: num(process.env.OPENEVALS_JEV_RPM, 1000),
  jevConcurrency: num(process.env.OPENEVALS_JEV_CONCURRENCY, 16),
  dailyBudgetUsd: num(process.env.OPENEVALS_DAILY_BUDGET_USD, 0), // 0 = unlimited
  /** public base URL of this server, used for deep links written into Langfuse score metadata */
  publicUrl: (process.env.OPENEVALS_PUBLIC_URL || "").replace(/\/$/, ""),

  // Langfuse connector: pull observations, judge, write scores back. Enabled when the three LANGFUSE_* vars are set.
  langfuse: {
    host: (process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || "").replace(/\/$/, ""),
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || undefined,
    secretKey: process.env.LANGFUSE_SECRET_KEY || undefined,
    pollMs: num(process.env.LANGFUSE_POLL_MS, 30_000),
    /** observations younger than this are left for the next poll so a trace has settled before it is judged */
    settleS: num(process.env.LANGFUSE_SETTLE_S, 90),
    /** re-read this far behind the watermark to pick up late-arriving observations */
    overlapS: num(process.env.LANGFUSE_OVERLAP_S, 300),
    /** on first start, how far back to pull */
    lookbackS: num(process.env.LANGFUSE_LOOKBACK_S, 3600),
    pageLimit: num(process.env.LANGFUSE_PAGE_LIMIT, 500),
    /** max observations per poll tick (bounds one tick's work) */
    maxPerTick: num(process.env.LANGFUSE_MAX_PER_TICK, 5000),
    /** only pull these environments (comma-separated); empty = all */
    environments: (process.env.LANGFUSE_ENVIRONMENTS || "").split(",").map((x) => x.trim()).filter(Boolean),
    /** only pull traces whose root observation has one of these names; empty = all */
    traceNames: (process.env.LANGFUSE_TRACE_NAMES || "").split(",").map((x) => x.trim()).filter(Boolean),
    /** annotation queue that low-confidence / failed traces are pushed into (optional) */
    reviewQueueId: process.env.LANGFUSE_REVIEW_QUEUE_ID || undefined,
    /** name of the human verdict score in Langfuse annotations; mapped to our `passed` for calibration */
    verdictScore: process.env.LANGFUSE_VERDICT_SCORE || "passed",
    /** write scores back at all (turn off to run read-only) */
    writeBack: bool(process.env.LANGFUSE_WRITE_BACK, true),
    /** which score names to write back; empty = every EVAL score. e.g. "passed,trajectory_quality,progress_mean" */
    writeBackScores: (process.env.LANGFUSE_WRITE_BACK_SCORES || "").split(",").map((x) => x.trim()).filter(Boolean),
    /** write per-step (observation-level) scores back too; they are numerous */
    writeBackSteps: bool(process.env.LANGFUSE_WRITE_BACK_STEPS, true),
  },

  // Rubric compiler (natural language → jev questions). Needs ANTHROPIC_API_KEY.
  compileModel: process.env.OPENEVALS_COMPILE_MODEL ?? process.env.OPENEVALS_ESCALATE_MODEL ?? "claude-sonnet-5",
};
export type Config = typeof config;
