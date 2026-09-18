// Evaluator lint: static checks that catch the ways rubrics written for a
// text-generating judge fail on jev. jev answers ONE typed question at a time,
// from the state alone, without reasoning or prose, so questions must be
// atomic, reference fields that exist, describe each level as a concrete
// situation, and leave the weights to the composite. Errors block saving;
// warnings and infos are returned alongside.
import type { Questions } from "@typesafe-ai/sdk";
import type { CompositeSpec, Transform } from "./aggregate.js";
import type { EvaluatorFilter } from "../db/repo.js";
import type { CodeCheck } from "./code.js";

export interface LintFinding {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  question?: string;
  fix?: string;
}

export interface LintInput {
  kind?: "jev" | "code";
  target?: "trace" | "observation";
  filter?: EvaluatorFilter | null;
  questions: Record<string, unknown>;
  composite?: unknown | null;
}

/** State fields each target exposes to questions (root -> allowed children; [] = opaque value). */
export const STATE_FIELDS: Record<"trace" | "observation", Record<string, string[]>> = {
  trace: {
    task: [],
    final_output: [],
    expected_output: [],
    trajectory: ["i", "type", "name", "depth", "duration_ms", "level", "status_message", "model", "input", "output", "judgments", "elided", "omitted_steps"],
    stats: ["steps", "llm_calls", "tool_calls", "errors", "warnings", "duration_ms", "total_tokens"],
    step_summary: ["steps_judged", "progress_mean", "no_progress_steps", "longest_stall", "wasted_steps", "wasted_fraction", "off_task_steps", "first_off_task_step", "errors", "errors_recovered", "error_recovery_rate", "mean_steps_to_recover"],
  },
  observation: {
    task: [],
    step: ["i", "type", "name", "depth", "duration_ms", "level", "status_message", "model", "input", "output"],
    context: ["position", "parent", "previous_steps", "previous_steps_omitted", "last_error", "final_output"],
  },
};

/** Per-step judgment keys that trace-level questions may mention bare (they live under `trajectory[].judgments`). */
export const STEP_JUDGMENT_KEYS = ["progress", "on_task", "redundant", "corrective", "step_quality", "tool_call_quality", "arguments_appropriate", "result_usefulness", "redundant_call"];

const CODE_CHECK_TYPES = new Set([
  "output_nonempty",
  "output_contains",
  "output_not_contains",
  "output_regex",
  "output_equals_expected",
  "output_contains_expected",
  "output_max_chars",
  "output_json",
  "max_steps",
  "max_tool_calls",
  "max_llm_calls",
  "max_duration_ms",
  "max_total_tokens",
  "max_cost_usd",
  "no_errors",
  "no_unresolved_error",
  "required_tools",
  "forbidden_tools",
  "max_repeated_tool_call",
]);
const ESCAPE_OPTIONS = new Set(["other", "none", "cannot_determine", "unknown", "not_applicable", "n_a", "na", "unclear", "insufficient_evidence"]);
// Cyrillic, Arabic, Devanagari, CJK, Hangul: the question is probably not in English.
const NON_LATIN = /[Ѐ-ӿ؀-ۿऀ-ॿ぀-ヿ㐀-鿿가-힯]/;
const TRANSFORM_TYPE: Record<Transform, "noul" | "score" | "choice"> = { noul: "noul", noul_inverted: "noul", score_norm: "score", score_norm_inverted: "score", choice_is: "choice" };
// "Did X, and did Y?" / "Is X or is Y" — two clauses each with their own verb.
const COMPOUND = /\b(and|or)\s+(does|did|is|are|was|were|has|have|can|could|should|will|would)\b/i;

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** The natural-language part of `instructions` (string, or {question, context, ...}). */
export function questionText(instructions: unknown): string {
  if (typeof instructions === "string") return instructions;
  if (instructions && typeof instructions === "object") {
    const o = instructions as Record<string, unknown>;
    return text(o.question ?? o.text ?? o.prompt ?? instructions);
  }
  return text(instructions);
}

/** Backticked paths that look like state references, e.g. `step.input`, `trajectory`. */
export function stateRefs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/`([A-Za-z_][\w]*(?:\.[\w]+|\[\])*)`/g)) out.push(m[1]!);
  return out;
}

export function lintEvaluator(ev: LintInput): LintFinding[] {
  const f: LintFinding[] = [];
  const kind = ev.kind ?? ("checks" in ev.questions ? "code" : "jev");
  if (kind === "code") return lintCode(ev);
  const target = ev.target ?? "trace";
  const fields = STATE_FIELDS[target];
  const questions = ev.questions as Questions;
  const ids = Object.keys(questions);
  if (!ids.length) f.push({ level: "error", code: "no_questions", message: "a jev evaluator needs at least one question" });
  if (ids.length > 12) f.push({ level: "warn", code: "many_questions", message: `${ids.length} questions in one request; jev handles this, but a rubric this wide is usually two evaluators` });

  for (const [id, q] of Object.entries(questions)) {
    const push = (level: LintFinding["level"], code: string, message: string, fix?: string) => f.push({ level, code, message, question: id, ...(fix ? { fix } : {}) });
    if (!q || typeof q !== "object" || !("type" in q)) {
      push("error", "bad_question", "question must be an object with `type` noul | score | choice");
      continue;
    }
    if (!["noul", "score", "choice"].includes(q.type)) push("error", "bad_type", `unknown type "${String(q.type)}"; use noul (yes/no probability), score (ordered levels) or choice (categories)`);
    const qt = questionText(q.instructions).trim();
    const full = text(q.instructions) + " " + text((q as { criteria?: unknown }).criteria);
    if (!qt) push("error", "no_instructions", "question has no instructions; the id is not sent to the model, so the whole meaning must be in `instructions`", 'write the question as a full sentence, e.g. "Does `final_output` answer every part of `task`?"');
    if (qt.length > 700) push("warn", "long_question", `instructions are ${qt.length} chars; long prompts dilute jev's attention`, "move background into instructions.context and keep instructions.question to one sentence");
    if (NON_LATIN.test(full)) push("warn", "non_english", "instructions/criteria contain non-Latin text; jev is most accurate on English questions (the state itself can be in any language)");
    const stripped = qt.replace(/`[^`]*`/g, "");
    const qmarks = (stripped.match(/\?/g) ?? []).length;
    if (qmarks > 1) push("warn", "multiple_questions", `${qmarks} question marks: this reads as more than one question; jev answers one thing per question`, "split into separate questions and combine them in `composite`");
    else if (COMPOUND.test(stripped)) push("info", "compound", "the question joins two clauses with and/or; if both halves can be judged separately, split them so the composite can weight them");
    if (/\b(rate|grade|score)\b.*\b(1|0)\s*(-|to)\s*(5|7|10|100)\b/i.test(stripped) || /\bon a scale\b/i.test(stripped))
      push("error", "numeric_scale", "asks for a numeric rating; jev does not produce free numbers", 'use type "score" with a `criteria` list where each level describes a concrete situation');
    if (/\b(explain|justify|describe|why|rationale|summari[sz]e|list)\b/i.test(stripped)) push("warn", "asks_for_text", "asks for an explanation or text; jev never generates text, only the typed answer comes back", "ask the decision itself; rationales come from escalation to a reasoning model if needed");
    if (/\b(overall|general)\s+quality\b/i.test(stripped) || /\bhow good\b/i.test(stripped)) push("warn", "holistic", '"overall quality" is a judgment jev has to guess at', "decompose into the observable properties you mean (complete? correct? followed constraints? concise?) and weight them in `composite`");

    // state references
    const refs = stateRefs(full);
    if (!refs.length && qt) push("info", "no_state_ref", "no backticked state field is referenced; anchor the question to `task`, `final_output`, `trajectory` (or `step`, `context` per step) so jev knows where to look");
    const childNames = new Set([...Object.values(fields).flat(), ...STEP_JUDGMENT_KEYS]);
    for (const r of refs) {
      const [root, ...rest] = r.replace(/\[\]/g, "").split(".");
      if (!(root! in fields)) {
        if (!rest.length && childNames.has(root!)) continue; // bare mention of a sub-field, e.g. `level`, `judgments`
        const other = target === "trace" ? "observation" : "trace";
        if (root! in STATE_FIELDS[other]) push("error", "wrong_target_field", `\`${r}\` exists only in ${other}-level state; this evaluator targets "${target}"`, `set target: "${other}" or reference ${Object.keys(fields).map((k) => `\`${k}\``).join(", ")}`);
        else push("warn", "unknown_field", `\`${r}\` is not a field of the ${target}-level state (${Object.keys(fields).join(", ")})`);
        continue;
      }
      const children = fields[root!]!;
      if (rest.length && children.length && !children.includes(rest[0]!)) push("warn", "unknown_subfield", `\`${r}\`: \`${root}\` has no \`${rest[0]}\` (has ${children.join(", ")})`);
      if (root === "expected_output" && !ev.filter?.requiresExpectedOutput)
        push("warn", "expected_output_filter", "references `expected_output` but the filter does not require it; the question is dropped on traces without one", "set filter.requiresExpectedOutput: true");
    }
    if (target === "observation" && /context\.final_output/.test(full) && !/\b(only|not|don't|do not)\b/i.test(full))
      push("info", "hindsight", "uses `context.final_output` when judging a step; make sure the question does not grade the step by hindsight");

    // per type
    if (q.type === "score") {
      const c = (q as { criteria?: unknown }).criteria;
      if (!Array.isArray(c) || c.length < 2) push("error", "score_criteria", "score questions need `criteria`: an array of at least two level descriptions (index 0 = lowest)");
      else {
        if (c.length > 5) push("warn", "many_levels", `${c.length} levels; jev separates 3 to 4 well-described levels far better than fine scales`);
        c.forEach((lvl, i) => {
          const t = text(lvl);
          if (t.length < 25) push("warn", "thin_level", `level ${i} ("${t}") is too short to be a situation; describe what a run at this level looks like`, 'e.g. "Partially accomplished: addresses `task` but at least one stated requirement is missing or wrong"');
        });
        const norm = c.map((x) => text(x).toLowerCase().trim());
        if (new Set(norm).size !== norm.length) push("error", "duplicate_levels", "two score levels have identical text");
      }
    } else if (q.type === "choice") {
      const c = (q as { criteria?: unknown }).criteria;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length < 2) push("error", "choice_criteria", "choice questions need `criteria`: an object mapping at least two option keys to descriptions");
      else {
        const keys = Object.keys(c);
        if (!keys.some((k) => ESCAPE_OPTIONS.has(k.toLowerCase()))) push("info", "no_escape", "no escape option (other / none / cannot_determine); give the grader a way out so it does not force a wrong label");
        for (const [k, v] of Object.entries(c)) if (v !== null && text(v).length < 12) push("warn", "thin_option", `option "${k}" has almost no description; describe the situation it labels`);
        if (keys.length > 10) push("warn", "many_options", `${keys.length} options; confidence drops with very wide choices`);
      }
    } else if (q.type === "noul") {
      const c = (q as { criteria?: { true?: unknown; false?: unknown } }).criteria;
      if (!c || (c.true === undefined && c.false === undefined)) push("info", "noul_no_criteria", "no criteria.true / criteria.false; stating what yes and no mean sharpens the boundary and cuts undecided answers");
      else if (c.true === undefined || c.false === undefined) push("info", "noul_half_criteria", "only one of criteria.true / criteria.false is given; describe both sides");
    }
  }

  // composite
  const comp = ev.composite as CompositeSpec | null | undefined;
  if (comp) {
    if (!comp.name) f.push({ level: "error", code: "composite_name", message: "composite needs a `name` (the score it produces)" });
    if (!Array.isArray(comp.terms)) f.push({ level: "error", code: "composite_terms", message: "composite.terms must be an array" });
    else {
      let wsum = 0;
      for (const t of comp.terms) {
        const q = questions[t.q];
        if (!q) {
          f.push({ level: "error", code: "composite_unknown_q", message: `composite term references unknown question "${t.q}"`, question: t.q });
          continue;
        }
        const want = TRANSFORM_TYPE[t.transform];
        if (!want) f.push({ level: "error", code: "bad_transform", message: `unknown transform "${String(t.transform)}"`, question: t.q });
        else if (want !== q.type)
          f.push({
            level: "error",
            code: "transform_type",
            message: `transform "${t.transform}" needs a ${want} question but "${t.q}" is ${q.type}`,
            question: t.q,
            fix: q.type === "noul" ? "use noul / noul_inverted" : q.type === "score" ? "use score_norm / score_norm_inverted" : "use choice_is with `option`",
          });
        if (t.transform === "choice_is") {
          const opts = q.type === "choice" ? Object.keys(q.criteria) : [];
          if (!t.option) f.push({ level: "error", code: "choice_is_option", message: `choice_is on "${t.q}" needs \`option\``, question: t.q });
          else if (opts.length && !opts.includes(t.option)) f.push({ level: "error", code: "choice_is_option", message: `choice_is option "${t.option}" is not one of ${opts.join(", ")}`, question: t.q });
        }
        if (typeof t.weight !== "number" || t.weight < 0) f.push({ level: "error", code: "bad_weight", message: `weight of "${t.q}" must be a non-negative number`, question: t.q });
        else wsum += t.weight;
      }
      if (comp.terms.length && wsum === 0) f.push({ level: "warn", code: "zero_weights", message: "all composite weights are 0" });
      const unweighted = ids.filter((id) => !comp.terms.some((t) => t.q === id) && !(comp.pass ?? []).some((r) => r.q === id));
      if (unweighted.length && comp.terms.length) f.push({ level: "info", code: "unused_questions", message: `questions not used by the composite or pass rules: ${unweighted.join(", ")} (fine if they are diagnostics only)` });
    }
    for (const r of comp.pass ?? []) {
      const q = questions[r.q];
      if (!q) f.push({ level: "error", code: "pass_unknown_q", message: `pass rule references unknown question "${r.q}"`, question: r.q });
      else if (q.type === "choice" && !["==", "!="].includes(r.op)) f.push({ level: "error", code: "pass_choice_op", message: `pass rule on choice "${r.q}" must use == or !=`, question: r.q });
      else if (q.type !== "choice" && typeof r.value !== "number") f.push({ level: "error", code: "pass_value", message: `pass rule on "${r.q}" needs a numeric value`, question: r.q });
      else if (q.type === "noul" && typeof r.value === "number" && (r.value < 0 || r.value > 1)) f.push({ level: "error", code: "pass_range", message: `noul "${r.q}" is a probability in [0,1]; rule value ${r.value} can never change`, question: r.q });
    }
    if (comp.pass && !comp.pass.length) f.push({ level: "info", code: "empty_pass", message: "composite.pass is empty; no pass/fail score will be produced" });
  } else if (ids.length > 1) {
    f.push({ level: "info", code: "no_composite", message: "no composite: each question becomes its own score, but there will be no single quality number or pass/fail", fix: "add composite { name, terms: [{ q, weight, transform }], pass: [...] }" });
  }
  return f;
}

function lintCode(ev: LintInput): LintFinding[] {
  const f: LintFinding[] = [];
  const checks = ((ev.questions as { checks?: CodeCheck[] }).checks ?? []) as (CodeCheck & Record<string, unknown>)[];
  if (!checks.length) f.push({ level: "error", code: "no_checks", message: "code evaluators need a non-empty `checks` array" });
  const names = new Set<string>();
  for (const c of checks) {
    const name = c.name ?? c.type;
    if (names.has(name)) f.push({ level: "error", code: "duplicate_check", message: `two checks named "${name}"; give one a \`name\``, question: name });
    names.add(name);
    if (!CODE_CHECK_TYPES.has(c.type)) {
      f.push({ level: "error", code: "unknown_check", message: `unknown check type "${c.type}"`, question: name });
      continue;
    }
    if (c.type.startsWith("max_") && typeof c.value !== "number") f.push({ level: "error", code: "check_value", message: `${c.type} needs a numeric \`value\``, question: name });
    if ((c.type === "output_contains" || c.type === "output_not_contains") && typeof c.value !== "string") f.push({ level: "error", code: "check_value", message: `${c.type} needs a string \`value\``, question: name });
    if ((c.type === "required_tools" || c.type === "forbidden_tools") && !Array.isArray(c.tools)) f.push({ level: "error", code: "check_tools", message: `${c.type} needs a \`tools\` array`, question: name });
    if (c.type === "output_regex") {
      try {
        new RegExp(String(c.pattern), typeof c.flags === "string" ? c.flags : undefined);
      } catch (e) {
        f.push({ level: "error", code: "bad_regex", message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`, question: name });
      }
    }
    if ((c.type === "output_equals_expected" || c.type === "output_contains_expected") && !ev.filter?.requiresExpectedOutput)
      f.push({ level: "warn", code: "expected_output_filter", message: `${c.type} fails on traces without expected_output`, question: name, fix: "set filter.requiresExpectedOutput: true" });
  }
  if (ev.composite && typeof ev.composite === "object" && Array.isArray((ev.composite as CompositeSpec).terms) && (ev.composite as CompositeSpec).terms.length)
    f.push({ level: "info", code: "code_composite", message: "code evaluators ignore composite.terms (only passName is used); the score is the fraction of checks passed" });
  return f;
}

export const hasErrors = (findings: LintFinding[]): boolean => findings.some((x) => x.level === "error");
