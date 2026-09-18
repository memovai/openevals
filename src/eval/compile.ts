// Rubric compiler: natural-language rubric -> jev evaluator (typed atomic
// questions + composite weights + pass rules). A reasoning model does the
// decomposition once, at design time; jev then answers the result cheaply on
// every trace. The output is linted and, if it has errors, sent back once
// with the findings for repair.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { anthropicCostUsd } from "./escalate.js";
import { lintEvaluator, hasErrors, STATE_FIELDS, type LintFinding } from "./lint.js";
import type { CompositeSpec } from "./aggregate.js";

export interface CompileRequest {
  name: string;
  /** free-form rubric, checklist, or description of what good and bad runs look like */
  rubric: string;
  target?: "trace" | "observation";
  /** what the agent does, what tools it has (helps name the right state fields) */
  agent?: string;
  /** optional labeled examples the questions must separate */
  examples?: { summary: string; verdict: "pass" | "fail"; why?: string }[];
}

export interface CompiledEvaluator {
  description: string;
  target: "trace" | "observation";
  questions: Record<string, unknown>;
  composite: CompositeSpec;
  /** what the model could not express as a jev question (needs a code check or a reasoning grader) */
  notes: string[];
}

export interface CompileResult {
  evaluator: CompiledEvaluator;
  lint: LintFinding[];
  attempts: number;
  model: string;
  costUsd: number;
}

export interface Compiler {
  readonly model: string;
  compile(req: CompileRequest, feedback?: { previous: CompiledEvaluator; findings: LintFinding[] }): Promise<{ evaluator: CompiledEvaluator; usage: { input_tokens: number; output_tokens: number }; model: string }>;
}

const Output = z.object({
  description: z.string(),
  questions: z.array(
    z.object({
      id: z.string().regex(/^[a-z][a-z0-9_]*$/),
      type: z.enum(["noul", "score", "choice"]),
      question: z.string(),
      context: z.string().nullable(),
      /** score: ordered level descriptions, index 0 = worst */
      levels: z.array(z.string()).nullable(),
      /** choice: options */
      options: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string() })).nullable(),
      /** noul */
      yes_means: z.string().nullable(),
      no_means: z.string().nullable(),
    }),
  ),
  composite: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    terms: z.array(z.object({ q: z.string(), weight: z.number(), transform: z.enum(["noul", "noul_inverted", "score_norm", "score_norm_inverted", "choice_is"]), option: z.string().nullable() })),
    pass: z.array(z.object({ q: z.string(), op: z.enum(["<", "<=", ">", ">=", "==", "!="]), value: z.union([z.number(), z.string()]) })),
    pass_name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }),
  notes: z.array(z.string()),
});
type Output = z.infer<typeof Output>;

export function toEvaluator(o: Output, target: "trace" | "observation"): CompiledEvaluator {
  const questions: Record<string, unknown> = {};
  for (const q of o.questions) {
    const instructions = q.context ? { question: q.question, context: q.context } : q.question;
    if (q.type === "score") questions[q.id] = { type: "score", instructions, criteria: q.levels ?? [] };
    else if (q.type === "choice") questions[q.id] = { type: "choice", instructions, criteria: Object.fromEntries((q.options ?? []).map((x) => [x.key, x.description])) };
    else questions[q.id] = { type: "noul", instructions, ...(q.yes_means || q.no_means ? { criteria: { ...(q.yes_means ? { true: q.yes_means } : {}), ...(q.no_means ? { false: q.no_means } : {}) } } : {}) };
  }
  const composite: CompositeSpec = {
    name: o.composite.name,
    terms: o.composite.terms.map((t) => ({ q: t.q, weight: t.weight, transform: t.transform, ...(t.option ? { option: t.option } : {}) })),
    pass: o.composite.pass,
    passName: o.composite.pass_name,
  };
  return { description: o.description, target, questions, composite, notes: o.notes };
}

export const DESIGN_RULES = `You convert an evaluation rubric into questions for jev, a fast typed judge.

What jev is: it reads a JSON "state" and answers each question with a typed value and a probability. It never writes text, never reasons across steps, and answers every question independently. It is very accurate on questions that a careful reader could answer by looking at the state, and poor on questions that need inference, world knowledge, or a holistic opinion.

Rules for the questions you produce:
1. One observable property per question. Never "and"/"or" two properties. Never ask for "overall quality".
2. Pick the type by what the answer is:
   - noul: a yes/no fact ("Does \`final_output\` cite a URL that appears in \`trajectory\`?"). Give yes_means and no_means.
   - score: an ordered degree with 3 (at most 4) levels. Each level describes a concrete situation a reader can recognise, worst first. No numeric scales.
   - choice: a category (e.g. failure mode). Include an escape option such as "none" and "cannot_determine".
3. Anchor every question to state fields with backticks. Use ONLY these fields:
{FIELDS}
4. Write in English, in full sentences. The question id is NOT shown to the model; the whole meaning goes in \`question\`. Put background in \`context\`.
5. Do not ask for explanations, rationales, lists, or numbers.
6. Weights and pass/fail live in the composite, not in the questions: transforms noul (P yes), noul_inverted (1 - P yes), score_norm (level / top), score_norm_inverted, choice_is (with option). Pass rules are gates on raw answers: nouls compare to 0.5, scores to a level threshold like 1.5, choices with == / !=.
7. Anything in the rubric that is a crisp deterministic check (a regex on the output, a step limit, a forbidden tool, exact match with a reference) should NOT become a jev question. Put it in \`notes\` as "code check: ..." so the user adds a code grader instead.
8. Anything that needs multi-step reasoning or outside knowledge also goes in \`notes\` ("needs reasoning grader: ...").
9. 4 to 8 questions is the sweet spot. Prefer the outcome (what was produced) over rigid step-by-step process checks; keep process questions to a low weight.`;

const SYSTEM = (target: "trace" | "observation") => {
  const fields = Object.entries(STATE_FIELDS[target])
    .map(([k, kids]) => `   - \`${k}\`${kids.length ? ` (${kids.map((x) => `\`${k}.${x}\``).join(", ")})` : ""}`)
    .join("\n");
  const doc =
    target === "trace"
      ? "The state is a whole agent run: `task` (the request), `trajectory` (ordered steps with inputs/outputs; `level` ERROR marks failures; steps may carry `judgments` from a per-step grader), `final_output`, optional `expected_output`, `stats`, optional `step_summary`."
      : "The state is ONE step of a run: `task`, `step` (the step under review with `step.input`, `step.output`, `step.level`), `context.previous_steps`, `context.last_error`, `context.final_output` (do not grade the step by hindsight).";
  return DESIGN_RULES.replace("{FIELDS}", `${doc}\n${fields}`);
};

function userPrompt(req: CompileRequest, feedback?: { previous: CompiledEvaluator; findings: LintFinding[] }): string {
  const parts = [`## Evaluator name\n${req.name}`];
  if (req.agent) parts.push(`## The agent\n${req.agent}`);
  parts.push(`## Rubric\n${req.rubric}`);
  if (req.examples?.length) parts.push(`## Labeled examples the questions must separate\n${req.examples.map((e) => `- [${e.verdict}] ${e.summary}${e.why ? ` (why: ${e.why})` : ""}`).join("\n")}`);
  if (feedback) {
    parts.push(
      `## Your previous attempt failed lint. Fix every error, keep everything else.\n\`\`\`json\n${JSON.stringify({ questions: feedback.previous.questions, composite: feedback.previous.composite }, null, 1)}\n\`\`\`\nFindings:\n${feedback.findings.map((f) => `- ${f.level} ${f.code}${f.question ? ` [${f.question}]` : ""}: ${f.message}${f.fix ? ` Fix: ${f.fix}` : ""}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export class ClaudeCompiler implements Compiler {
  private client: Anthropic;
  readonly model: string;
  constructor(opts: { model?: string; apiKey?: string } = {}) {
    this.model = opts.model ?? config.compileModel;
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }
  async compile(req: CompileRequest, feedback?: { previous: CompiledEvaluator; findings: LintFinding[] }) {
    const target = req.target ?? "trace";
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      system: SYSTEM(target),
      messages: [{ role: "user", content: userPrompt(req, feedback) }],
      output_config: { format: zodOutputFormat(Output) },
    });
    if (response.stop_reason === "refusal") throw new Error(`compile refused: ${response.stop_details?.category ?? "unknown"}`);
    const parsed = response.parsed_output as Output | null;
    if (!parsed) throw new Error("compile returned no parseable output");
    return { evaluator: toEvaluator(parsed, target), usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }, model: response.model };
  }
}

/** Compile, lint, and repair once if the result has lint errors. */
export async function compileRubric(compiler: Compiler, req: CompileRequest): Promise<CompileResult> {
  let cost = 0;
  let attempts = 0;
  let model = compiler.model;
  let out = await compiler.compile(req);
  attempts++;
  cost += anthropicCostUsd(out.model, out.usage);
  model = out.model;
  let lint = lintEvaluator({ kind: "jev", target: out.evaluator.target, questions: out.evaluator.questions, composite: out.evaluator.composite });
  if (hasErrors(lint)) {
    out = await compiler.compile(req, { previous: out.evaluator, findings: lint });
    attempts++;
    cost += anthropicCostUsd(out.model, out.usage);
    lint = lintEvaluator({ kind: "jev", target: out.evaluator.target, questions: out.evaluator.questions, composite: out.evaluator.composite });
  }
  return { evaluator: out.evaluator, lint, attempts, model, costUsd: cost };
}

export function compilerFromEnv(): Compiler | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  return new ClaudeCompiler({ model: config.compileModel });
}
