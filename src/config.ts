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
};
export type Config = typeof config;
