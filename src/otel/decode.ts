// Decode an OTLP ExportTraceServiceRequest (protobuf or JSON) into a flat list
// of normalized spans. Proto files are vendored from open-telemetry/opentelemetry-proto
// (Apache-2.0) under src/otel/proto and parsed once at startup with protobufjs.
import protobuf from "protobufjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));

export type AttrValue = string | number | boolean | AttrValue[] | { [k: string]: AttrValue } | null;

export interface OtelSpan {
  traceId: string; // hex
  spanId: string; // hex
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, AttrValue>;
  resourceAttributes: Record<string, AttrValue>;
  scopeName: string | null;
  status: { code: number; message: string | null };
  events: { name: string; timeUnixNano: bigint; attributes: Record<string, AttrValue> }[];
}

let root: protobuf.Root | null = null;
let ExportReq: protobuf.Type | null = null;

function loadRoot(): protobuf.Type {
  if (ExportReq) return ExportReq;
  root = new protobuf.Root();
  // resolve `import "opentelemetry/proto/..."` against the vendored directory
  root.resolvePath = (_origin: string, target: string) => join(here, "proto", target);
  root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto", { keepCase: true });
  ExportReq = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
  return ExportReq;
}

// ---- AnyValue → JS ----
type AnyValueMsg = {
  string_value?: string;
  bool_value?: boolean;
  int_value?: number | string | Long;
  double_value?: number;
  array_value?: { values?: AnyValueMsg[] };
  kvlist_value?: { values?: { key: string; value?: AnyValueMsg }[] };
  bytes_value?: Uint8Array | string;
  // JSON encoding uses camelCase
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string;
  doubleValue?: number;
  arrayValue?: { values?: AnyValueMsg[] };
  kvlistValue?: { values?: { key: string; value?: AnyValueMsg }[] };
  bytesValue?: string;
};
type Long = { low: number; high: number; unsigned: boolean; toString(): string };

function anyValue(v: AnyValueMsg | undefined | null): AttrValue {
  if (!v) return null;
  if (v.string_value !== undefined) return v.string_value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.bool_value !== undefined) return v.bool_value;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.int_value !== undefined) return Number(String(v.int_value));
  if (v.intValue !== undefined) return Number(String(v.intValue));
  if (v.double_value !== undefined) return v.double_value;
  if (v.doubleValue !== undefined) return v.doubleValue;
  const arr = v.array_value ?? v.arrayValue;
  if (arr) return (arr.values ?? []).map(anyValue);
  const kv = v.kvlist_value ?? v.kvlistValue;
  if (kv) return Object.fromEntries((kv.values ?? []).map((e) => [e.key, anyValue(e.value)]));
  const b = v.bytes_value ?? v.bytesValue;
  if (b !== undefined) return typeof b === "string" ? b : Buffer.from(b).toString("base64");
  return null;
}

function attrs(list: { key: string; value?: AnyValueMsg }[] | undefined): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const kv of list ?? []) out[kv.key] = anyValue(kv.value);
  return out;
}

function hex(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") {
    // JSON encoding: hex per spec, but some exporters emit base64; detect.
    if (/^[0-9a-fA-F]+$/.test(v) && (v.length === 32 || v.length === 16)) return v.toLowerCase();
    return Buffer.from(v, "base64").toString("hex");
  }
  return Buffer.from(v as Uint8Array).toString("hex");
}

function nanos(v: unknown): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v || "0");
  const l = v as Long;
  if (typeof l.toString === "function") return BigInt(l.toString());
  return 0n;
}

type SpanMsg = Record<string, unknown>;
const get = <T>(o: SpanMsg, snake: string, camel: string): T | undefined => (o[snake] ?? o[camel]) as T | undefined;

function normalizeRequest(req: SpanMsg): OtelSpan[] {
  const out: OtelSpan[] = [];
  const rss = get<SpanMsg[]>(req, "resource_spans", "resourceSpans") ?? [];
  for (const rs of rss) {
    const resource = get<SpanMsg>(rs, "resource", "resource");
    const rattrs = attrs(resource?.attributes as never);
    const sss = get<SpanMsg[]>(rs, "scope_spans", "scopeSpans") ?? get<SpanMsg[]>(rs, "instrumentation_library_spans", "instrumentationLibrarySpans") ?? [];
    for (const ss of sss) {
      const scope = get<SpanMsg>(ss, "scope", "scope");
      const spans = (ss.spans as SpanMsg[]) ?? [];
      for (const s of spans) {
        const status = get<SpanMsg>(s, "status", "status") ?? {};
        out.push({
          traceId: hex(get(s, "trace_id", "traceId")),
          spanId: hex(get(s, "span_id", "spanId")),
          parentSpanId: hex(get(s, "parent_span_id", "parentSpanId")) || null,
          name: String(s.name ?? ""),
          kind: Number(s.kind ?? 0),
          startTimeUnixNano: nanos(get(s, "start_time_unix_nano", "startTimeUnixNano")),
          endTimeUnixNano: nanos(get(s, "end_time_unix_nano", "endTimeUnixNano")),
          attributes: attrs(s.attributes as never),
          resourceAttributes: rattrs,
          scopeName: (scope?.name as string | undefined) ?? null,
          status: { code: Number(status.code ?? 0), message: (status.message as string | undefined) || null },
          events: ((s.events as SpanMsg[]) ?? []).map((e) => ({
            name: String(e.name ?? ""),
            timeUnixNano: nanos(get(e, "time_unix_nano", "timeUnixNano")),
            attributes: attrs(e.attributes as never),
          })),
        });
      }
    }
  }
  return out;
}

export function decodeOtlp(body: Uint8Array, contentType: string | undefined, contentEncoding?: string): OtelSpan[] {
  let buf: Uint8Array = body;
  if (contentEncoding?.toLowerCase().includes("gzip")) buf = gunzipSync(buf);
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) {
    return normalizeRequest(JSON.parse(Buffer.from(buf).toString("utf8")) as SpanMsg);
  }
  const T = loadRoot();
  const msg = T.decode(buf);
  const obj = T.toObject(msg, { longs: String, enums: Number, bytes: Uint8Array as never, defaults: false, arrays: true, objects: true }) as SpanMsg;
  return normalizeRequest(obj);
}

export const nanosToIso = (n: bigint): string => new Date(Number(n / 1_000_000n)).toISOString();
