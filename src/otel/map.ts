// Map OTel spans → Langfuse-shaped trace/observation upserts.
// Understands Langfuse's own OTel attribute conventions plus the common
// GenAI instrumentations (OTel gen_ai.*, OpenInference, OpenLLMetry, Vercel AI SDK).
import type { AttrValue, OtelSpan } from "./decode.js";
import { nanosToIso } from "./decode.js";
import type { ObservationRow, TraceRow } from "../db/repo.js";

const str = (v: AttrValue | undefined): string | undefined => (typeof v === "string" ? v : v === undefined || v === null ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v));
const num = (v: AttrValue | undefined): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
/** Parse JSON-in-a-string attributes (Langfuse/OpenInference serialise input/output as JSON strings). */
const jsonish = (v: AttrValue | undefined): unknown => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return v;
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
};

function first<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

/** Collect `prefix.*` attributes into an object (e.g. langfuse.observation.metadata.foo). */
function collectPrefixed(a: Record<string, AttrValue>, prefix: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith(prefix + ".")) {
      out[k.slice(prefix.length + 1)] = jsonish(v);
      any = true;
    }
  }
  const whole = a[prefix];
  if (whole !== undefined) {
    const parsed = jsonish(whole);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(out, parsed as object), (any = true);
  }
  return any ? out : undefined;
}

/** OpenLLMetry style: gen_ai.prompt.0.role / gen_ai.prompt.0.content … */
function indexedMessages(a: Record<string, AttrValue>, prefix: string): unknown[] | undefined {
  const re = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)\\.(\\w+)$`);
  const msgs: Record<number, Record<string, unknown>> = {};
  let any = false;
  for (const [k, v] of Object.entries(a)) {
    const m = re.exec(k);
    if (!m) continue;
    any = true;
    const i = Number(m[1]);
    (msgs[i] ??= {})[m[2]!] = jsonish(v);
  }
  return any ? Object.keys(msgs).map(Number).sort((x, y) => x - y).map((i) => msgs[i]) : undefined;
}

export function observationType(s: OtelSpan): string {
  const a = s.attributes;
  const explicit = str(a["langfuse.observation.type"]);
  if (explicit) return explicit.toUpperCase();
  const oi = str(a["openinference.span.kind"]);
  if (oi) {
    const m: Record<string, string> = { LLM: "GENERATION", TOOL: "TOOL", AGENT: "AGENT", CHAIN: "CHAIN", RETRIEVER: "RETRIEVER", EMBEDDING: "EMBEDDING", GUARDRAIL: "GUARDRAIL", EVALUATOR: "EVALUATOR", RERANKER: "RETRIEVER" };
    return m[oi.toUpperCase()] ?? "SPAN";
  }
  const op = str(a["gen_ai.operation.name"]);
  if (op) {
    if (["chat", "text_completion", "generate_content", "generate"].includes(op)) return "GENERATION";
    if (op === "embeddings") return "EMBEDDING";
    if (op === "execute_tool") return "TOOL";
    if (["invoke_agent", "create_agent"].includes(op)) return "AGENT";
  }
  if (a["gen_ai.tool.name"] !== undefined || s.name.startsWith("ai.toolCall")) return "TOOL";
  if (a["gen_ai.request.model"] !== undefined || a["llm.model_name"] !== undefined || a["ai.model.id"] !== undefined) return "GENERATION";
  if (s.name.endsWith(".doGenerate") || s.name.endsWith(".doStream")) return "GENERATION";
  return "SPAN";
}

function inputOf(a: Record<string, AttrValue>): unknown {
  return first(
    jsonish(a["langfuse.observation.input"]),
    jsonish(a["input.value"]),
    jsonish(a["gen_ai.input.messages"]),
    jsonish(a["gen_ai.prompt"]),
    indexedMessages(a, "gen_ai.prompt"),
    jsonish(a["ai.prompt.messages"]),
    jsonish(a["ai.prompt"]),
    jsonish(a["ai.toolCall.args"]),
    jsonish(a["gen_ai.tool.call.arguments"]),
    jsonish(a["tool.parameters"]),
  );
}
function outputOf(a: Record<string, AttrValue>): unknown {
  return first(
    jsonish(a["langfuse.observation.output"]),
    jsonish(a["output.value"]),
    jsonish(a["gen_ai.output.messages"]),
    jsonish(a["gen_ai.completion"]),
    indexedMessages(a, "gen_ai.completion"),
    jsonish(a["ai.response.text"]),
    jsonish(a["ai.response.object"]),
    jsonish(a["ai.response.toolCalls"]),
    jsonish(a["ai.toolCall.result"]),
    jsonish(a["gen_ai.tool.call.result"]),
  );
}

function usageOf(a: Record<string, AttrValue>): { input?: number; output?: number; total?: number } {
  const ud = jsonish(a["langfuse.observation.usage_details"]) as Record<string, unknown> | undefined;
  const input = first(num(ud?.input as AttrValue), num(a["gen_ai.usage.input_tokens"]), num(a["gen_ai.usage.prompt_tokens"]), num(a["llm.token_count.prompt"]), num(a["ai.usage.promptTokens"]), num(a["ai.usage.inputTokens"]));
  const output = first(num(ud?.output as AttrValue), num(a["gen_ai.usage.output_tokens"]), num(a["gen_ai.usage.completion_tokens"]), num(a["llm.token_count.completion"]), num(a["ai.usage.completionTokens"]), num(a["ai.usage.outputTokens"]));
  const total = first(num(ud?.total as AttrValue), num(a["llm.usage.total_tokens"]), num(a["llm.token_count.total"]), input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  return { input, output, total };
}

export interface Mapped {
  trace: Partial<TraceRow> & { id: string };
  observation: Partial<ObservationRow> & { id: string; trace_id: string };
  isRoot: boolean;
}

export function mapSpan(s: OtelSpan, _spanIdsInBatch: Set<string>): Mapped {
  const a = s.attributes;
  const r = s.resourceAttributes;
  const type = observationType(s);
  const usage = usageOf(a);
  // A span is the trace root only when it has no parent at all. A child whose parent
  // arrives in a later export batch must not be mistaken for the root and rename the trace.
  const isRoot = !s.parentSpanId;
  const level = first(str(a["langfuse.observation.level"])?.toUpperCase(), s.status.code === 2 ? "ERROR" : undefined) as string | undefined;

  const observation: Mapped["observation"] = {
    id: s.spanId,
    trace_id: s.traceId,
    parent_observation_id: s.parentSpanId ?? null,
    type,
    // tool spans from gen_ai / Vercel AI carry the real tool name in an attribute
    name: type === "TOOL" ? first(str(a["gen_ai.tool.name"]), str(a["ai.toolCall.name"]), s.name) ?? s.name : s.name,
    start_time: nanosToIso(s.startTimeUnixNano),
    end_time: s.endTimeUnixNano > 0n ? nanosToIso(s.endTimeUnixNano) : null,
    completion_start_time: str(a["langfuse.observation.completion_start_time"]) ?? null,
    input: inputOf(a),
    output: outputOf(a),
    metadata: collectPrefixed(a, "langfuse.observation.metadata") ?? residualMetadata(a),
    level: level ?? "DEFAULT",
    status_message: first(str(a["langfuse.observation.status_message"]), s.status.message ?? undefined) ?? null,
    model: first(str(a["langfuse.observation.model.name"]), str(a["gen_ai.response.model"]), str(a["gen_ai.request.model"]), str(a["llm.model_name"]), str(a["ai.model.id"])) ?? null,
    model_parameters: (jsonish(a["langfuse.observation.model_parameters"]) as Record<string, unknown> | undefined) ?? collectPrefixed(a, "gen_ai.request") ?? null,
    usage_input: usage.input ?? null,
    usage_output: usage.output ?? null,
    usage_total: usage.total ?? null,
    cost_usd: first(num((jsonish(a["langfuse.observation.cost_details"]) as Record<string, AttrValue> | undefined)?.total), num(a["gen_ai.usage.cost"])) ?? null,
  };

  const tagsRaw = a["langfuse.trace.tags"];
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : typeof tagsRaw === "string" ? (jsonish(tagsRaw) as string[] | string) : undefined;
  const trace: Mapped["trace"] = {
    id: s.traceId,
    name: first(str(a["langfuse.trace.name"]), isRoot ? s.name : undefined),
    user_id: first(str(a["langfuse.user.id"]), str(a["user.id"]), str(a["enduser.id"])),
    session_id: first(str(a["langfuse.session.id"]), str(a["session.id"]), str(a["gen_ai.conversation.id"])),
    input: first(jsonish(a["langfuse.trace.input"]), isRoot ? observation.input : undefined),
    output: first(jsonish(a["langfuse.trace.output"]), isRoot ? observation.output : undefined),
    expected_output: jsonish(a["openevals.trace.expected_output"]) ?? jsonish(a["langfuse.trace.expected_output"]),
    metadata: collectPrefixed(a, "langfuse.trace.metadata"),
    tags: Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : undefined,
    release: first(str(a["langfuse.release"]), str(r["service.version"])),
    version: str(a["langfuse.version"]),
    environment: first(str(a["langfuse.environment"]), str(r["deployment.environment.name"]), str(r["deployment.environment"])),
    timestamp: isRoot ? observation.start_time : undefined,
  };
  return { trace, observation, isRoot };
}

const KNOWN_PREFIXES = ["langfuse.", "gen_ai.", "llm.", "ai.", "input.", "output.", "openinference.", "session.", "user.", "tool.", "openevals."];
function residualMetadata(a: Record<string, AttrValue>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(a)) {
    if (KNOWN_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : undefined;
}
