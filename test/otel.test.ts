import { describe, it, expect } from "vitest";
import protobuf from "protobufjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { decodeOtlp } from "../src/otel/decode.js";
import { mapSpan, observationType } from "../src/otel/map.js";
import { createApp } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const protoDir = join(here, "..", "src", "otel", "proto");

function encodeRequest(json: unknown): Uint8Array {
  const root = new protobuf.Root();
  root.resolvePath = (_o, t) => join(protoDir, t);
  root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto", { keepCase: true });
  const T = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
  const msg = T.fromObject(json as never);
  return T.encode(msg).finish();
}

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const ROOT = "b7ad6b7169203331";
const CHILD = "00f067aa0ba902b7";
const kv = (key: string, value: Record<string, unknown>) => ({ key, value });
const str = (v: string) => ({ string_value: v });
const int = (v: number) => ({ int_value: v });

// Langfuse-style attributes on a root agent span + a gen_ai child generation.
const protoRequest = {
  resource_spans: [
    {
      resource: { attributes: [kv("service.name", str("demo-agent")), kv("deployment.environment.name", str("staging"))] },
      scope_spans: [
        {
          scope: { name: "langfuse-sdk" },
          spans: [
            {
              trace_id: Buffer.from(TRACE, "hex"),
              span_id: Buffer.from(ROOT, "hex"),
              name: "support-agent",
              kind: 1,
              start_time_unix_nano: "1758153600000000000",
              end_time_unix_nano: "1758153602500000000",
              attributes: [
                kv("langfuse.observation.type", str("agent")),
                kv("langfuse.observation.input", str(JSON.stringify({ question: "Where is my order?" }))),
                kv("langfuse.observation.output", str("Your order ships tomorrow.")),
                kv("langfuse.session.id", str("sess-1")),
                kv("langfuse.trace.tags", str(JSON.stringify(["prod", "tier1"]))),
                kv("langfuse.trace.metadata.customer", str("acme")),
              ],
              status: { code: 1 },
            },
            {
              trace_id: Buffer.from(TRACE, "hex"),
              span_id: Buffer.from(CHILD, "hex"),
              parent_span_id: Buffer.from(ROOT, "hex"),
              name: "chat claude-sonnet-5",
              kind: 3,
              start_time_unix_nano: "1758153600100000000",
              end_time_unix_nano: "1758153601900000000",
              attributes: [
                kv("gen_ai.operation.name", str("chat")),
                kv("gen_ai.request.model", str("claude-sonnet-5")),
                kv("gen_ai.usage.input_tokens", int(812)),
                kv("gen_ai.usage.output_tokens", int(120)),
                kv("gen_ai.prompt.0.role", str("user")),
                kv("gen_ai.prompt.0.content", str("Where is my order?")),
                kv("gen_ai.completion.0.role", str("assistant")),
                kv("gen_ai.completion.0.content", str("Your order ships tomorrow.")),
              ],
              status: { code: 2, message: "upstream timeout" },
            },
          ],
        },
      ],
    },
  ],
};

describe("OTLP decode", () => {
  it("decodes protobuf, including 64-bit nanos and byte ids", () => {
    const spans = decodeOtlp(encodeRequest(protoRequest), "application/x-protobuf");
    expect(spans).toHaveLength(2);
    const root = spans.find((s) => s.spanId === ROOT)!;
    expect(root.traceId).toBe(TRACE);
    expect(root.parentSpanId).toBeNull();
    expect(root.startTimeUnixNano).toBe(1758153600000000000n);
    expect(root.resourceAttributes["service.name"]).toBe("demo-agent");
    const child = spans.find((s) => s.spanId === CHILD)!;
    expect(child.parentSpanId).toBe(ROOT);
    expect(child.attributes["gen_ai.usage.input_tokens"]).toBe(812);
    expect(child.status).toEqual({ code: 2, message: "upstream timeout" });
  });
  it("decodes gzip + JSON encoding with hex ids and string nanos", () => {
    const json = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "x" } }] },
          scopeSpans: [{ spans: [{ traceId: TRACE, spanId: ROOT, name: "root", startTimeUnixNano: "1758153600000000000", endTimeUnixNano: "1758153601000000000", attributes: [{ key: "input.value", value: { stringValue: "hi" } }, { key: "openinference.span.kind", value: { stringValue: "LLM" } }] }] }],
        },
      ],
    };
    const spans = decodeOtlp(gzipSync(Buffer.from(JSON.stringify(json))), "application/json", "gzip");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe(TRACE);
    expect(spans[0]!.endTimeUnixNano).toBe(1758153601000000000n);
    expect(observationType(spans[0]!)).toBe("GENERATION");
  });
});

describe("OTel → Langfuse mapping", () => {
  const spans = decodeOtlp(encodeRequest(protoRequest), "application/x-protobuf");
  const ids = new Set(spans.map((s) => s.spanId));
  it("maps the root span onto the trace", () => {
    const m = mapSpan(spans.find((s) => s.spanId === ROOT)!, ids);
    expect(m.isRoot).toBe(true);
    expect(m.observation.type).toBe("AGENT");
    expect(m.trace.name).toBe("support-agent");
    expect(m.trace.input).toEqual({ question: "Where is my order?" });
    expect(m.trace.output).toBe("Your order ships tomorrow.");
    expect(m.trace.session_id).toBe("sess-1");
    expect(m.trace.tags).toEqual(["prod", "tier1"]);
    expect(m.trace.metadata).toEqual({ customer: "acme" });
    expect(m.trace.environment).toBe("staging");
    expect(m.observation.start_time).toBe("2025-09-18T00:00:00.000Z");
  });
  it("maps gen_ai.* onto a GENERATION with usage, messages and ERROR level", () => {
    const m = mapSpan(spans.find((s) => s.spanId === CHILD)!, ids);
    expect(m.isRoot).toBe(false);
    expect(m.observation.type).toBe("GENERATION");
    expect(m.observation.model).toBe("claude-sonnet-5");
    expect(m.observation.usage_input).toBe(812);
    expect(m.observation.usage_total).toBe(932);
    expect(m.observation.input).toEqual([{ role: "user", content: "Where is my order?" }]);
    expect(m.observation.level).toBe("ERROR");
    expect(m.observation.status_message).toBe("upstream timeout");
    expect(m.observation.parent_observation_id).toBe(ROOT);
    expect(m.trace.name).toBeUndefined(); // child must not rename the trace
  });
});

describe("OTLP endpoint", () => {
  it("ingests protobuf at the Langfuse path and schedules eval", async () => {
    const { app, repo } = createApp({ dbPath: ":memory:", judge: { model: "fake", judge: async () => ({ model: "fake", answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0 }) }, quiet: true });
    const res = await app.request("/api/public/otel/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: encodeRequest(protoRequest) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-protobuf");
    const t = repo.getTrace(TRACE)!;
    expect(t.name).toBe("support-agent");
    expect(t.output).toBe("Your order ships tomorrow.");
    const obs = repo.listObservations(TRACE);
    expect(obs.map((o) => o.type)).toEqual(["AGENT", "GENERATION"]);
    expect(repo.queueStats().pending).toBeGreaterThan(0);
    // second export of only the child (late-arriving) must not clobber trace name/output
    const childOnly = { resource_spans: [{ scope_spans: [{ spans: [protoRequest.resource_spans[0]!.scope_spans[0]!.spans[1]] }] }] };
    await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: encodeRequest(childOnly) });
    expect(repo.getTrace(TRACE)!.name).toBe("support-agent");
    expect(repo.listObservations(TRACE)).toHaveLength(2);
  });
  it("rejects garbage", async () => {
    const { app } = createApp({ dbPath: ":memory:", judge: null, quiet: true });
    const res = await app.request("/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });
});
