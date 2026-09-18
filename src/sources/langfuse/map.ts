// Langfuse v2 observations → openevals trace + observation rows. Langfuse has no
// separate trace read in the real-time path, so trace-level fields come from
// the logical root observation (isRootObservation) and the trace_context field
// group (traceName, tags, release).
import type { ObservationRow, TraceRow } from "../../db/repo.js";
import type { LangfuseObservationV2 } from "./client.js";

/** v2 returns input/output as raw strings; recover JSON when it parses, keep text otherwise. */
export function parseIo(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return v;
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]")) || s === "null" || s === "true" || s === "false") {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}

export function groupByTrace(obs: LangfuseObservationV2[]): Map<string, LangfuseObservationV2[]> {
  const out = new Map<string, LangfuseObservationV2[]>();
  for (const o of obs) {
    if (!o.traceId) continue;
    out.set(o.traceId, [...(out.get(o.traceId) ?? []), o]);
  }
  return out;
}

export function rootOf(obs: LangfuseObservationV2[]): LangfuseObservationV2 | undefined {
  const sorted = [...obs].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return sorted.find((o) => o.isRootObservation) ?? sorted.find((o) => !o.parentObservationId) ?? sorted[0];
}

export function toTraceRow(traceId: string, obs: LangfuseObservationV2[], opts: { host: string; traceUrl: (projectId: string, traceId: string) => string }): Partial<TraceRow> & { id: string } {
  const root = rootOf(obs);
  const first = [...obs].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))[0];
  const last = [...obs].filter((o) => o.endTime).sort((a, b) => Date.parse(b.endTime!) - Date.parse(a.endTime!))[0];
  const row: Partial<TraceRow> & { id: string } = {
    id: traceId,
    project_id: root?.projectId ?? first?.projectId ?? "default",
    source: "langfuse",
    timestamp: first?.startTime ?? new Date().toISOString(),
    external_url: root ? opts.traceUrl(root.projectId, traceId) : null,
  };
  if (root) {
    row.name = root.traceName ?? root.name ?? null;
    row.user_id = root.userId ?? null;
    row.session_id = root.sessionId ?? null;
    row.environment = root.environment ?? null;
    row.release = root.release ?? null;
    row.version = root.version ?? null;
    if (root.tags) row.tags = root.tags;
    if (root.input !== undefined) row.input = parseIo(root.input);
    // a root that is still running has no output yet; the last finished observation's output stands in until it does
    if (root.output !== undefined && root.output !== null) row.output = parseIo(root.output);
    else if (last && last.id !== root.id && last.output !== undefined) row.output = parseIo(last.output);
    row.metadata = { langfuse: { projectId: root.projectId, rootObservationId: root.id, host: opts.host } };
  }
  return row;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function toObservationRow(o: LangfuseObservationV2): Partial<ObservationRow> & { id: string; trace_id: string } {
  const usage = o.usageDetails ?? {};
  const input = num(usage.input) ?? num(usage.input_tokens) ?? num(usage.promptTokens);
  const output = num(usage.output) ?? num(usage.output_tokens) ?? num(usage.completionTokens);
  const total = num(usage.total) ?? num(usage.total_tokens) ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  const row: Partial<ObservationRow> & { id: string; trace_id: string } = {
    id: o.id,
    trace_id: o.traceId!,
    parent_observation_id: o.parentObservationId ?? null,
    type: (o.type || "SPAN").toUpperCase(),
    name: o.name ?? null,
    start_time: o.startTime,
    end_time: o.endTime ?? null,
    completion_start_time: o.completionStartTime ?? null,
    level: (o.level ?? "DEFAULT").toUpperCase(),
    status_message: o.statusMessage ?? null,
    model: o.model ?? null,
    usage_input: input,
    usage_output: output,
    usage_total: total,
    cost_usd: num(o.totalCost),
  };
  if (o.input !== undefined) row.input = parseIo(o.input);
  if (o.output !== undefined) row.output = parseIo(o.output);
  if (o.metadata !== undefined && o.metadata !== null) row.metadata = (typeof o.metadata === "object" ? o.metadata : { value: o.metadata }) as Record<string, unknown>;
  if (o.modelParameters !== undefined && o.modelParameters !== null) row.model_parameters = o.modelParameters as Record<string, unknown>;
  return row;
}
