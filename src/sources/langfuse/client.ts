// Minimal Langfuse public-API client for the connector. Only the endpoints the
// connector needs, all on the current (non-deprecated) surface:
//   GET  /api/public/v2/observations   the only real-time read path (others lag ~10 min)
//   POST /api/public/ingestion         batch score-create events (write-back)
//   GET  /api/public/v3/scores         human annotations for calibration
//   POST /api/public/annotation-queues/{id}/items
//   GET  /api/public/projects
// Auth is HTTP Basic public:secret. 429/5xx are retried with backoff and Retry-After.

export interface LangfuseObservationV2 {
  id: string;
  traceId: string | null;
  startTime: string;
  endTime: string | null;
  projectId: string;
  parentObservationId: string | null;
  type: string;
  isRootObservation?: boolean;
  name?: string | null;
  level?: string;
  statusMessage?: string | null;
  version?: string | null;
  environment?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  completionStartTime?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  model?: string | null;
  modelParameters?: unknown;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  totalCost?: number | null;
  tags?: string[];
  release?: string | null;
  traceName?: string | null;
}

export interface LangfuseScoreV3 {
  id: string;
  name: string;
  source: "ANNOTATION" | "API" | "EVAL";
  timestamp: string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "TEXT" | "CORRECTION";
  value?: number | null;
  stringValue?: string | null;
  comment?: string | null;
  configId?: string | null;
  metadata?: Record<string, unknown>;
  authorUserId?: string | null;
  queueId?: string | null;
  environment?: string;
  subject?: { kind: "trace" | "observation" | "session" | "experiment"; id: string; traceId?: string };
  /** v1/v2-shaped responses (older self-hosted versions) */
  traceId?: string | null;
  observationId?: string | null;
}

export interface IngestionEvent {
  id: string;
  type: "score-create";
  timestamp: string;
  body: Record<string, unknown>;
}

export interface IngestionResponse {
  successes: { id: string; status: number }[];
  errors: { id: string; status: number; message?: string; error?: unknown }[];
}

export class LangfuseApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`Langfuse ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "LangfuseApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LangfuseClientOptions {
  host: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}

export class LangfuseClient {
  readonly host: string;
  private auth: string;
  private f: typeof fetch;
  private maxRetries: number;
  constructor(opts: LangfuseClientOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.auth = "Basic " + Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString("base64");
    this.f = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | string[] | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.host + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else url.searchParams.set(k, String(v));
    }
    let attempt = 0;
    for (;;) {
      const res = await this.f(url, {
        method,
        headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new LangfuseApiError(res.status, path, text);
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt));
      attempt++;
    }
  }

  /** One page of observations that started in [fromStartTime, toStartTime). */
  listObservations(params: {
    fromStartTime: string;
    toStartTime?: string;
    cursor?: string;
    limit?: number;
    fields?: string;
    environment?: string[];
    type?: string;
    traceId?: string;
  }): Promise<{ data: LangfuseObservationV2[]; meta: { cursor?: string } }> {
    return this.request("GET", "/api/public/v2/observations", {
      query: {
        fromStartTime: params.fromStartTime,
        toStartTime: params.toStartTime,
        cursor: params.cursor,
        limit: params.limit ?? 500,
        fields: params.fields ?? "basic,io,metadata,model,usage,trace_context",
        environment: params.environment,
        type: params.type,
        traceId: params.traceId,
      },
    });
  }

  /** Every observation of one trace (follows the cursor). */
  async observationsOfTrace(traceId: string, fromStartTime: string): Promise<LangfuseObservationV2[]> {
    const out: LangfuseObservationV2[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listObservations({ traceId, fromStartTime, cursor, limit: 1000 });
      out.push(...page.data);
      cursor = page.meta?.cursor;
    } while (cursor);
    return out;
  }

  /** Batch ingestion; used for score-create events. 207 carries per-event results. */
  ingest(events: IngestionEvent[]): Promise<IngestionResponse> {
    return this.request("POST", "/api/public/ingestion", { body: { batch: events } });
  }

  listScores(params: { source?: string; fromTimestamp?: string; toTimestamp?: string; cursor?: string; limit?: number; name?: string }): Promise<{ data: LangfuseScoreV3[]; meta: { cursor?: string; page?: number; totalPages?: number } }> {
    return this.request("GET", "/api/public/v3/scores", {
      query: { source: params.source, fromTimestamp: params.fromTimestamp, toTimestamp: params.toTimestamp, cursor: params.cursor, limit: params.limit ?? 100, name: params.name, fields: "core,details,subject,annotation" },
    });
  }

  addAnnotationQueueItem(queueId: string, objectId: string, objectType: "TRACE" | "OBSERVATION" | "SESSION" = "TRACE"): Promise<unknown> {
    return this.request("POST", `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items`, { body: { objectId, objectType } });
  }

  getProjects(): Promise<{ data: { id: string; name: string }[] }> {
    return this.request("GET", "/api/public/projects");
  }

  traceUrl(projectId: string, traceId: string, observationId?: string | null): string {
    const base = `${this.host}/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
    return observationId ? `${base}?observation=${encodeURIComponent(observationId)}` : base;
  }
}
