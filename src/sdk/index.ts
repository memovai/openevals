// Tiny client SDK. Zero dependencies; speaks the Langfuse batch-event wire
// format, so the same server also accepts real Langfuse SDKs.
//
//   const eva = new OpenEva({ baseUrl: "http://localhost:3100" });
//   const trace = eva.trace({ name: "support-agent", input: userMessage });
//   const gen = trace.generation({ name: "plan", model: "claude-sonnet-5", input: msgs });
//   gen.end({ output: reply, usage: { input: 812, output: 120 } });
//   const tool = trace.tool({ name: "search", input: { q } });
//   tool.end({ output: results });
//   trace.update({ output: finalAnswer });
//   await eva.flush();
import { randomUUID } from "node:crypto";

export interface OpenEvaOptions {
  baseUrl?: string;
  apiKey?: string;
  /** flush automatically after this many ms of inactivity (default 1000; 0 = manual) */
  flushIntervalMs?: number;
  /** max events per HTTP request */
  batchSize?: number;
  fetch?: typeof fetch;
}

type Level = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
export type ObservationType = "span" | "generation" | "event" | "agent" | "tool" | "chain" | "retriever" | "embedding" | "guardrail" | "evaluator";

export interface TraceInit {
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  expectedOutput?: unknown;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  release?: string;
  version?: string;
  environment?: string;
  timestamp?: Date;
}
export interface ObservationInit {
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: Level;
  statusMessage?: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  startTime?: Date;
  endTime?: Date;
}
export interface ObservationEnd {
  output?: unknown;
  level?: Level;
  statusMessage?: string;
  metadata?: Record<string, unknown>;
  usage?: { input?: number; output?: number; total?: number };
  cost?: number;
  endTime?: Date;
  model?: string;
}

interface Event {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

const iso = (d?: Date) => (d ?? new Date()).toISOString();

export class OpenEva {
  private queue: Event[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenEvaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENEVA_URL ?? "http://localhost:3100").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENEVA_API_KEY;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 100;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  trace(init: TraceInit = {}): Trace {
    const id = init.id ?? randomUUID();
    this.emit("trace-create", {
      id,
      name: init.name,
      input: init.input,
      output: init.output,
      expectedOutput: init.expectedOutput,
      userId: init.userId,
      sessionId: init.sessionId,
      metadata: init.metadata,
      tags: init.tags,
      release: init.release,
      version: init.version,
      environment: init.environment,
      timestamp: iso(init.timestamp),
    });
    return new Trace(this, id);
  }

  score(s: { traceId: string; observationId?: string; name: string; value: number | string | boolean; comment?: string; metadata?: Record<string, unknown> }): void {
    this.emit("score-create", { id: randomUUID(), ...s, timestamp: iso() });
  }

  /** @internal */
  emit(type: string, body: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    this.queue.push({ id: randomUUID(), type, timestamp: iso(), body: clean });
    if (this.queue.length >= this.batchSize) void this.flush();
    else if (this.flushIntervalMs > 0 && !this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.inflight = (async () => {
      for (let i = 0; i < batch.length; i += this.batchSize) {
        const chunk = batch.slice(i, i + this.batchSize);
        const res = await this.fetchImpl(`${this.baseUrl}/api/public/ingestion`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({ batch: chunk }),
        });
        if (!res.ok && res.status !== 207) throw new Error(`openeva ingest failed: ${res.status} ${await res.text()}`);
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

export class Trace {
  constructor(
    private client: OpenEva,
    public readonly id: string,
  ) {}

  update(patch: Omit<TraceInit, "id" | "timestamp">): this {
    this.client.emit("trace-create", { id: this.id, ...patch });
    return this;
  }
  span(init: ObservationInit = {}, parent?: Observation): Observation {
    return this.start("span", init, parent);
  }
  generation(init: ObservationInit = {}, parent?: Observation): Observation {
    return this.start("generation", init, parent);
  }
  tool(init: ObservationInit = {}, parent?: Observation): Observation {
    return this.start("tool", init, parent);
  }
  agent(init: ObservationInit = {}, parent?: Observation): Observation {
    return this.start("agent", init, parent);
  }
  event(init: ObservationInit = {}, parent?: Observation): Observation {
    const o = this.start("event", { ...init, endTime: init.endTime ?? init.startTime ?? new Date() }, parent);
    return o;
  }
  observation(type: ObservationType, init: ObservationInit = {}, parent?: Observation): Observation {
    return this.start(type, init, parent);
  }
  score(s: { name: string; value: number | string | boolean; comment?: string; observationId?: string }): this {
    this.client.score({ traceId: this.id, ...s });
    return this;
  }

  private start(type: ObservationType, init: ObservationInit, parent?: Observation): Observation {
    const id = init.id ?? randomUUID();
    this.client.emit(`${type}-create`, {
      id,
      traceId: this.id,
      parentObservationId: parent?.id,
      name: init.name,
      input: init.input,
      output: init.output,
      metadata: init.metadata,
      level: init.level,
      statusMessage: init.statusMessage,
      model: init.model,
      modelParameters: init.modelParameters,
      startTime: iso(init.startTime),
      endTime: init.endTime ? iso(init.endTime) : undefined,
    });
    return new Observation(this.client, this, id, type);
  }
}

export class Observation {
  constructor(
    private client: OpenEva,
    public readonly trace: Trace,
    public readonly id: string,
    public readonly type: ObservationType,
  ) {}

  update(patch: ObservationEnd & { input?: unknown; name?: string }): this {
    this.client.emit(`${this.type}-update`, {
      id: this.id,
      traceId: this.trace.id,
      name: patch.name,
      input: patch.input,
      output: patch.output,
      level: patch.level,
      statusMessage: patch.statusMessage,
      metadata: patch.metadata,
      model: patch.model,
      usage: patch.usage,
      totalCost: patch.cost,
      endTime: patch.endTime ? iso(patch.endTime) : undefined,
    });
    return this;
  }
  end(patch: ObservationEnd = {}): this {
    return this.update({ ...patch, endTime: patch.endTime ?? new Date() });
  }
  /** child observations */
  span(init: ObservationInit = {}): Observation {
    return this.trace.span(init, this);
  }
  generation(init: ObservationInit = {}): Observation {
    return this.trace.generation(init, this);
  }
  tool(init: ObservationInit = {}): Observation {
    return this.trace.tool(init, this);
  }
  event(init: ObservationInit = {}): Observation {
    return this.trace.event(init, this);
  }
}
