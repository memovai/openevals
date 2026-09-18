// OTLP/HTTP trace ingestion — what Langfuse v3+ SDKs and any OpenTelemetry
// exporter send. Accepts protobuf (default) or JSON, optionally gzip.
//   POST /api/public/otel/v1/traces   (Langfuse SDK default path)
//   POST /v1/traces                   (plain OTLP exporter default path)
import { Hono, type Context } from "hono";
import type { Repo } from "../db/repo.js";
import { decodeOtlp } from "../otel/decode.js";
import { mapSpan } from "../otel/map.js";
import { scheduleTrace } from "../eval/worker.js";

export function otelRoutes(repo: Repo, opts: { evalEnabled: boolean }): Hono {
  const app = new Hono();
  const handler = async (c: Context) => {
    const ct = c.req.header("content-type");
    const isJson = (ct ?? "").toLowerCase().includes("json");
    let spans;
    try {
      const body = new Uint8Array(await c.req.arrayBuffer());
      spans = decodeOtlp(body, ct, c.req.header("content-encoding"));
    } catch (e) {
      return c.json({ error: "could not decode OTLP payload", detail: e instanceof Error ? e.message : String(e) }, 400);
    }
    const ids = new Set(spans.map((s) => s.spanId));
    const touched = new Set<string>();
    // Parents before children so depth/tree resolve on first insert; roots set trace fields first.
    spans.sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0));
    repo.db.exec("BEGIN");
    try {
      for (const s of spans) {
        const m = mapSpan(s, ids);
        const existing = repo.getTrace(m.trace.id);
        if (!existing) repo.upsertTrace(m.trace);
        else {
          // Only overwrite trace-level input/output from a root span if not explicitly set via langfuse.trace.* attrs.
          const patch = { ...m.trace };
          if (!m.isRoot) {
            delete patch.input;
            delete patch.output;
            delete patch.name;
          }
          delete patch.timestamp;
          repo.upsertTrace(patch);
        }
        repo.upsertObservation(m.observation);
        touched.add(m.trace.id);
      }
      repo.db.exec("COMMIT");
    } catch (e) {
      repo.db.exec("ROLLBACK");
      throw e;
    }
    if (opts.evalEnabled) for (const t of touched) scheduleTrace(repo, t);
    if (isJson) return c.json({ partialSuccess: {} });
    // Empty ExportTraceServiceResponse encodes to zero bytes.
    return c.body(new Uint8Array(0), 200, { "content-type": "application/x-protobuf" });
  };
  app.post("/api/public/otel/v1/traces", handler);
  app.post("/v1/traces", handler);
  return app;
}
