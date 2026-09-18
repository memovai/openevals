// Thin wrapper around the TypeSafe SDK. jev returns typed answers with
// probabilities; it never generates text. One request evaluates every
// question against the same state in parallel, so we always batch.
import { TypeSafeClient, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { config } from "../config.js";

export type JevAnswers = SystemOneResult<Questions>["answers"];

export interface Judge {
  readonly model: string;
  judge(state: unknown, questions: Questions): Promise<{ model: string; answers: JevAnswers; usage: { input_tokens: number; output_tokens: number }; latencyMs: number }>;
}

/**
 * Request budget shared by every jev call in the process: at most `rpm` requests in any sliding
 * 60 s window and `concurrency` in flight. jev's published limit is 1,200 requests/min; grading every
 * step of 100k traces/day is ~1,450/min, so without this the connector would trip 429s in bursts.
 */
export class RateLimiter {
  private starts: number[] = [];
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  constructor(
    public rpm: number,
    public concurrency: number,
  ) {}
  get stats() {
    const now = Date.now();
    this.starts = this.starts.filter((t) => now - t < 60_000);
    return { last_minute: this.starts.length, in_flight: this.inFlight, waiting: this.waiters.length, rpm: this.rpm, concurrency: this.concurrency };
  }
  private wake(): void {
    const w = this.waiters.shift();
    if (w) w();
  }
  async acquire(): Promise<() => void> {
    for (;;) {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < 60_000);
      if (this.inFlight < this.concurrency && this.starts.length < this.rpm) break;
      const waitMs = this.starts.length >= this.rpm ? Math.max(20, 60_000 - (now - this.starts[0]!)) : 0;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        if (waitMs) setTimeout(() => this.wake(), waitMs).unref?.();
      });
    }
    this.inFlight++;
    this.starts.push(Date.now());
    return () => {
      this.inFlight--;
      this.wake();
    };
  }
}

export const jevLimiter = new RateLimiter(config.jevRpm, config.jevConcurrency);

export class JevJudge implements Judge {
  private client: TypeSafeClient;
  readonly model: string;
  constructor(
    opts: { apiKey: string; model?: string; baseURL?: string },
    private limiter: RateLimiter = jevLimiter,
  ) {
    this.model = opts.model ?? config.jevModel;
    this.client = new TypeSafeClient({ apiKey: opts.apiKey, defaultModel: this.model, baseURL: opts.baseURL, timeout: 30_000 });
  }
  async judge(state: unknown, questions: Questions) {
    const release = await this.limiter.acquire();
    try {
      const t0 = performance.now();
      // jev accepts string | object | array as state; our TraceState is a plain object.
      const res = await this.client.systemOne({ state: state as never, questions, model: this.model });
      return { model: res.model, answers: res.answers, usage: res.usage, latencyMs: Math.round(performance.now() - t0) };
    } finally {
      release();
    }
  }
}

export function judgeFromEnv(): Judge | null {
  if (!config.typesafeApiKey) return null;
  return new JevJudge({ apiKey: config.typesafeApiKey, model: config.jevModel, baseURL: process.env.TYPESAFE_BASE_URL || undefined });
}

export const costUsd = (inputTokens: number): number => inputTokens * config.jevUsdPerInputToken;
