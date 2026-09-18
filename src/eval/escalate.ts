// Escalation: when jev's confidence is low, ask a reasoning model (Claude) the
// SAME questions and get a rationale back. Output is coerced into the jev
// answer shape so the rest of the pipeline (scores, composites, UI) is unchanged;
// the rationale lands in the score comment.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Questions } from "@typesafe-ai/sdk";
import type { JevAnswers } from "./jev.js";
import { config } from "../config.js";

export interface Escalation {
  model: string;
  answers: JevAnswers;
  rationales: Record<string, string>;
  usage: { input_tokens: number; output_tokens: number };
  costUsd: number;
  latencyMs: number;
}

export interface Escalator {
  readonly model: string;
  escalate(state: unknown, questions: Questions): Promise<Escalation>;
}

// $/MTok input, output — first-party rates.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
};
export function anthropicCostUsd(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  const [i, o] = key ? PRICES[key]! : [5, 25];
  return (usage.input_tokens * i + usage.output_tokens * o) / 1e6;
}

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Build a strict output schema mirroring the question set. */
export function schemaFor(questions: Questions) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      shape[id] = z.object({ rationale: z.string(), probability_yes: z.number().min(0).max(1) });
    } else if (q.type === "score") {
      const n = q.criteria.length;
      shape[id] = z.object({ rationale: z.string(), level: z.number().int().min(0).max(n - 1) });
    } else {
      const opts = Object.keys(q.criteria) as [string, ...string[]];
      shape[id] = z.object({ rationale: z.string(), choice: z.enum(opts) });
    }
  }
  return z.object(shape);
}

export function renderQuestions(questions: Questions): string {
  const lines: string[] = [];
  for (const [id, q] of Object.entries(questions)) {
    lines.push(`### ${id} (${q.type})`);
    if (q.instructions) lines.push(text(q.instructions));
    if (q.type === "noul") {
      if (q.criteria?.true) lines.push(`yes means: ${text(q.criteria.true)}`);
      if (q.criteria?.false) lines.push(`no means: ${text(q.criteria.false)}`);
      lines.push("Answer with probability_yes in [0,1].");
    } else if (q.type === "score") {
      q.criteria.forEach((c, i) => lines.push(`  level ${i}: ${text(c)}`));
      lines.push("Answer with the integer level that fits best.");
    } else {
      for (const [k, v] of Object.entries(q.criteria)) lines.push(`  ${k}: ${text(v)}`);
      lines.push("Answer with exactly one option key.");
    }
    lines.push("");
  }
  return lines.join("\n");
}

const SYSTEM = `You are grading an AI agent run for an evaluation system. You receive a JSON "state" describing the run and a list of typed questions about it. A fast first-pass grader was not confident, so you are the careful second opinion.

Rules:
- Judge only from what is in the state. Do not assume facts that are not there.
- Answer every question. Keep each rationale to one or two sentences citing the specific evidence (step numbers, quoted fragments).
- For probability questions, use the full [0,1] range honestly; 0.5 means genuinely undecidable from the evidence.`;

/** Coerce parsed output into jev-shaped answers (one-hot probabilities, confidence 1). */
export function toJevAnswers(parsed: Record<string, Record<string, unknown>>, questions: Questions): { answers: JevAnswers; rationales: Record<string, string> } {
  const answers: Record<string, unknown> = {};
  const rationales: Record<string, string> = {};
  for (const [id, q] of Object.entries(questions)) {
    const p = parsed[id];
    if (!p) continue;
    rationales[id] = String(p.rationale ?? "");
    if (q.type === "noul") answers[id] = { type: "noul", noul: Number(p.probability_yes) };
    else if (q.type === "score") {
      const lvl = Number(p.level);
      const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === lvl ? 1 : 0]));
      answers[id] = { type: "score", score: lvl, confidence: 1, legend, probabilities };
    } else {
      const keys = Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === p.choice ? 1 : 0]));
      answers[id] = { type: "choice", choice: String(p.choice), confidence: 1, probabilities };
    }
  }
  return { answers: answers as JevAnswers, rationales };
}

export class ClaudeEscalator implements Escalator {
  private client: Anthropic;
  readonly model: string;
  constructor(opts: { model?: string; apiKey?: string } = {}) {
    this.model = opts.model ?? config.escalateModel;
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async escalate(state: unknown, questions: Questions): Promise<Escalation> {
    const t0 = performance.now();
    const schema = schemaFor(questions);
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `## State\n\`\`\`json\n${JSON.stringify(state, null, 1)}\n\`\`\`\n\n## Questions\n${renderQuestions(questions)}`,
        },
      ],
      output_config: { format: zodOutputFormat(schema) },
    });
    if (response.stop_reason === "refusal") throw new Error(`escalation refused: ${response.stop_details?.category ?? "unknown"}`);
    const parsed = response.parsed_output as Record<string, Record<string, unknown>> | null;
    if (!parsed) throw new Error("escalation returned no parseable output");
    const { answers, rationales } = toJevAnswers(parsed, questions);
    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    return { model: response.model, answers, rationales, usage, costUsd: anthropicCostUsd(response.model, usage), latencyMs: Math.round(performance.now() - t0) };
  }
}

export function escalatorFromEnv(): Escalator | null {
  if (!config.escalateEnabled) return null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  return new ClaudeEscalator({ model: config.escalateModel });
}
