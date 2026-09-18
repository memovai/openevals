// Code-based graders: deterministic, free, reproducible checks on a trace —
// the "code-based grader" tier from Anthropic's eval guide. They run before
// jev and cost nothing, so use them for everything that has a crisp answer
// (limits, required tools, output format, exact/normalised match) and leave
// nuance to jev.
import type { ObservationRow, TraceRow } from "../db/repo.js";

export type CodeCheck =
  | { name?: string; type: "output_nonempty" }
  | { name?: string; type: "output_contains"; value: string; caseInsensitive?: boolean }
  | { name?: string; type: "output_not_contains"; value: string; caseInsensitive?: boolean }
  | { name?: string; type: "output_regex"; pattern: string; flags?: string }
  | { name?: string; type: "output_equals_expected"; normalize?: boolean }
  | { name?: string; type: "output_contains_expected"; normalize?: boolean }
  | { name?: string; type: "output_max_chars"; value: number }
  | { name?: string; type: "output_json" }
  | { name?: string; type: "max_steps"; value: number }
  | { name?: string; type: "max_tool_calls"; value: number }
  | { name?: string; type: "max_llm_calls"; value: number }
  | { name?: string; type: "max_duration_ms"; value: number }
  | { name?: string; type: "max_total_tokens"; value: number }
  | { name?: string; type: "max_cost_usd"; value: number }
  | { name?: string; type: "no_errors" }
  | { name?: string; type: "no_unresolved_error" }
  | { name?: string; type: "required_tools"; tools: string[] }
  | { name?: string; type: "forbidden_tools"; tools: string[] }
  | { name?: string; type: "max_repeated_tool_call"; value: number };

export interface CodeCheckResult {
  name: string;
  type: string;
  passed: boolean;
  detail: string;
  /** optional measured value, for the score row */
  value?: number;
}

export interface TraceFeatures {
  steps: number;
  tool_calls: number;
  llm_calls: number;
  errors: number;
  last_level: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  tools_called: string[];
  max_repeat: { name: string; count: number } | null;
  output_chars: number;
}

const toText = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
const norm = (s: string): string => s.toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();

export function traceFeatures(trace: TraceRow, obs: ObservationRow[]): TraceFeatures {
  let tool = 0,
    llm = 0,
    errors = 0,
    tokens = 0,
    sawTokens = false,
    cost = 0,
    sawCost = false;
  let minStart: number | null = null,
    maxEnd: number | null = null;
  const tools: string[] = [];
  const repeats = new Map<string, number>();
  for (const o of obs) {
    if (o.type === "TOOL") {
      tool++;
      tools.push(o.name ?? "");
      const key = `${o.name}::${toText(o.input)}`;
      repeats.set(key, (repeats.get(key) ?? 0) + 1);
    }
    if (o.type === "GENERATION") llm++;
    if (o.level === "ERROR") errors++;
    if (o.usage_total != null) (tokens += o.usage_total), (sawTokens = true);
    if (o.cost_usd != null) (cost += o.cost_usd), (sawCost = true);
    const s = Date.parse(o.start_time),
      e = o.end_time ? Date.parse(o.end_time) : NaN;
    if (Number.isFinite(s)) minStart = minStart === null ? s : Math.min(minStart, s);
    if (Number.isFinite(e)) maxEnd = maxEnd === null ? e : Math.max(maxEnd, e);
  }
  let maxRepeat: TraceFeatures["max_repeat"] = null;
  for (const [k, n] of repeats) if (!maxRepeat || n > maxRepeat.count) maxRepeat = { name: k.split("::")[0]!, count: n };
  const last = obs.length ? obs[obs.length - 1]! : null;
  return {
    steps: obs.length,
    tool_calls: tool,
    llm_calls: llm,
    errors,
    last_level: last?.level ?? null,
    duration_ms: minStart !== null && maxEnd !== null ? maxEnd - minStart : null,
    total_tokens: sawTokens ? tokens : null,
    cost_usd: sawCost ? cost : null,
    tools_called: tools,
    max_repeat: maxRepeat,
    output_chars: toText(trace.output).length,
  };
}

export function runCodeChecks(trace: TraceRow, obs: ObservationRow[], checks: CodeCheck[]): { results: CodeCheckResult[]; features: TraceFeatures } {
  const f = traceFeatures(trace, obs);
  const out = toText(trace.output);
  const expected = toText(trace.expected_output);
  const results: CodeCheckResult[] = [];
  const push = (c: CodeCheck, passed: boolean, detail: string, value?: number) =>
    results.push({ name: c.name ?? c.type, type: c.type, passed, detail, ...(value !== undefined ? { value } : {}) });

  for (const c of checks) {
    switch (c.type) {
      case "output_nonempty":
        push(c, out.trim().length > 0, `output has ${f.output_chars} chars`, f.output_chars);
        break;
      case "output_contains": {
        const ok = c.caseInsensitive ? out.toLowerCase().includes(c.value.toLowerCase()) : out.includes(c.value);
        push(c, ok, ok ? `output contains ${JSON.stringify(c.value)}` : `output lacks ${JSON.stringify(c.value)}`);
        break;
      }
      case "output_not_contains": {
        const hit = c.caseInsensitive ? out.toLowerCase().includes(c.value.toLowerCase()) : out.includes(c.value);
        push(c, !hit, hit ? `output contains forbidden ${JSON.stringify(c.value)}` : `output free of ${JSON.stringify(c.value)}`);
        break;
      }
      case "output_regex": {
        let ok = false,
          detail = "";
        try {
          ok = new RegExp(c.pattern, c.flags).test(out);
          detail = ok ? `matches /${c.pattern}/` : `no match for /${c.pattern}/`;
        } catch (e) {
          detail = `invalid regex: ${e instanceof Error ? e.message : String(e)}`;
        }
        push(c, ok, detail);
        break;
      }
      case "output_equals_expected": {
        if (!expected) {
          push(c, false, "no expected_output on trace");
          break;
        }
        const ok = c.normalize === false ? out === expected : norm(out) === norm(expected);
        push(c, ok, ok ? "output equals expected" : `output ≠ expected (${c.normalize === false ? "exact" : "normalised"})`);
        break;
      }
      case "output_contains_expected": {
        if (!expected) {
          push(c, false, "no expected_output on trace");
          break;
        }
        const ok = c.normalize === false ? out.includes(expected) : norm(out).includes(norm(expected));
        push(c, ok, ok ? "output contains expected" : "expected answer not found in output");
        break;
      }
      case "output_max_chars":
        push(c, f.output_chars <= c.value, `${f.output_chars} chars (max ${c.value})`, f.output_chars);
        break;
      case "output_json": {
        let ok = typeof trace.output === "object" && trace.output !== null;
        if (!ok && typeof trace.output === "string") {
          try {
            JSON.parse(trace.output);
            ok = true;
          } catch {
            ok = false;
          }
        }
        push(c, ok, ok ? "output is valid JSON" : "output is not JSON");
        break;
      }
      case "max_steps":
        push(c, f.steps <= c.value, `${f.steps} steps (max ${c.value})`, f.steps);
        break;
      case "max_tool_calls":
        push(c, f.tool_calls <= c.value, `${f.tool_calls} tool calls (max ${c.value})`, f.tool_calls);
        break;
      case "max_llm_calls":
        push(c, f.llm_calls <= c.value, `${f.llm_calls} LLM calls (max ${c.value})`, f.llm_calls);
        break;
      case "max_duration_ms":
        push(c, f.duration_ms === null || f.duration_ms <= c.value, `${f.duration_ms ?? "?"} ms (max ${c.value})`, f.duration_ms ?? undefined);
        break;
      case "max_total_tokens":
        push(c, f.total_tokens === null || f.total_tokens <= c.value, `${f.total_tokens ?? "?"} tokens (max ${c.value})`, f.total_tokens ?? undefined);
        break;
      case "max_cost_usd":
        push(c, f.cost_usd === null || f.cost_usd <= c.value, `$${f.cost_usd ?? "?"} (max $${c.value})`, f.cost_usd ?? undefined);
        break;
      case "no_errors":
        push(c, f.errors === 0, `${f.errors} ERROR steps`, f.errors);
        break;
      case "no_unresolved_error":
        push(c, f.last_level !== "ERROR", f.last_level === "ERROR" ? "run ended on an ERROR step" : "last step not an error");
        break;
      case "required_tools": {
        const missing = c.tools.filter((t) => !f.tools_called.includes(t));
        push(c, missing.length === 0, missing.length ? `missing tool calls: ${missing.join(", ")}` : `all required tools called`);
        break;
      }
      case "forbidden_tools": {
        const used = c.tools.filter((t) => f.tools_called.includes(t));
        push(c, used.length === 0, used.length ? `forbidden tools called: ${used.join(", ")}` : "no forbidden tools called");
        break;
      }
      case "max_repeated_tool_call":
        push(c, (f.max_repeat?.count ?? 0) <= c.value, f.max_repeat ? `${f.max_repeat.name} called ${f.max_repeat.count}× with identical input (max ${c.value})` : "no repeated calls", f.max_repeat?.count ?? 0);
        break;
    }
  }
  return { results, features: f };
}
