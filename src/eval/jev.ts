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

export class JevJudge implements Judge {
  private client: TypeSafeClient;
  readonly model: string;
  constructor(opts: { apiKey: string; model?: string; baseURL?: string }) {
    this.model = opts.model ?? config.jevModel;
    this.client = new TypeSafeClient({ apiKey: opts.apiKey, defaultModel: this.model, baseURL: opts.baseURL, timeout: 30_000 });
  }
  async judge(state: unknown, questions: Questions) {
    const t0 = performance.now();
    // jev accepts string | object | array as state; our TraceState is a plain object.
    const res = await this.client.systemOne({ state: state as never, questions, model: this.model });
    return { model: res.model, answers: res.answers, usage: res.usage, latencyMs: Math.round(performance.now() - t0) };
  }
}

export function judgeFromEnv(): Judge | null {
  if (!config.typesafeApiKey) return null;
  return new JevJudge({ apiKey: config.typesafeApiKey, model: config.jevModel, baseURL: process.env.TYPESAFE_BASE_URL || undefined });
}

export const costUsd = (inputTokens: number): number => inputTokens * config.jevUsdPerInputToken;
