import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { ingestRoutes } from "./api/ingest.js";
import { otelRoutes } from "./api/otel.js";
import { restRoutes } from "./api/rest.js";
import { uiRoutes } from "./ui/pages.js";
import { judgeFromEnv, type Judge } from "./eval/jev.js";
import { escalatorFromEnv, type Escalator } from "./eval/escalate.js";
import { compilerFromEnv, type Compiler } from "./eval/compile.js";
import { langfuseFromEnv, type LangfuseSync } from "./sources/langfuse/sync.js";
import { EvalWorker, ensureBuiltins, escalateJudgment, evaluateTrace, orderEvaluators, scheduleTrace, type Judges } from "./eval/worker.js";
import { builtinEvaluators } from "./eval/builtin.js";

export interface AppOptions {
  dbPath?: string;
  judge?: Judge | null;
  escalator?: Escalator | null;
  compiler?: Compiler | null;
  /** Langfuse connector; undefined = from env, null = off */
  langfuse?: LangfuseSync | null | ((repo: Repo, schedule: (traceId: string, settleMs?: number) => void) => LangfuseSync | null);
  apiKey?: string;
  evalEnabled?: boolean;
  quiet?: boolean;
}

export function createApp(opts: AppOptions = {}) {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const repo = new Repo(db);
  ensureBuiltins(repo, builtinEvaluators);
  const judge = opts.judge === undefined ? judgeFromEnv() : opts.judge;
  const escalator = opts.escalator === undefined ? escalatorFromEnv() : opts.escalator;
  const compiler = opts.compiler === undefined ? compilerFromEnv() : opts.compiler;
  const judges: Judges = { judge, escalator };
  const evalEnabled = opts.evalEnabled ?? config.evalEnabled;
  const schedule = (traceId: string, settleMs?: number) => {
    if (evalEnabled) scheduleTrace(repo, traceId, settleMs, { hasJudge: !!judge });
  };

  const app = new Hono();
  if (!opts.quiet) app.use(logger());

  const apiKey = opts.apiKey ?? config.apiKey;
  if (apiKey) {
    app.use("/api/*", async (c, next) => {
      const h = c.req.header("authorization") ?? "";
      let ok = h === `Bearer ${apiKey}`;
      if (!ok && h.startsWith("Basic ")) {
        // Langfuse SDKs send Basic <publicKey>:<secretKey>; accept the secret half.
        const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
        ok = decoded.split(":").pop() === apiKey;
      }
      if (!ok) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }

  app.route("/", ingestRoutes(repo, { schedule }));
  app.route("/", otelRoutes(repo, { schedule }));
  const quietLog = { info() {}, warn() {}, error() {} };
  const langfuse = typeof opts.langfuse === "function" ? opts.langfuse(repo, schedule) : opts.langfuse === undefined ? langfuseFromEnv(repo, schedule, opts.quiet ? quietLog : console) : opts.langfuse;

  app.route("/", restRoutes(repo, judges, schedule, { compiler, langfuse }));
  app.route("/", uiRoutes(repo, { langfuse }));
  // form handler lives here because it needs the judge
  app.post("/traces/:id/evaluate", async (c) => {
    const id = c.req.param("id");
    for (const ev of orderEvaluators(repo.listEvaluators(true))) await evaluateTrace(repo, judges, ev, id, { force: true });
    return c.redirect(`/traces/${id}`);
  });
  app.post("/traces/:id/escalate", async (c) => {
    const id = c.req.param("id");
    if (judges.escalator) {
      const seen = new Set<string>();
      for (const jd of repo.listJudgments(id)) {
        if (jd.status !== "ok" || jd.escalated_from || jd.model === "code") continue;
        const key = `${jd.evaluator_id}:${jd.observation_id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ev = repo.getEvaluator(jd.evaluator_id);
        if (ev) await escalateJudgment(repo, judges.escalator, ev, jd);
      }
    }
    return c.redirect(`/traces/${id}`);
  });

  const worker = evalEnabled ? new EvalWorker(repo, judges, opts.quiet ? quietLog : console) : null;
  return { app, repo, db, judge, escalator, compiler, worker, langfuse };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const { app, judge, escalator, compiler, worker, langfuse } = createApp();
  worker?.start();
  langfuse?.start();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`openevals listening on http://localhost:${info.port}  db=${config.dbPath}`);
    if (judge) console.log(`eval: on (model ${judge.model}, settle ${config.settleMs}ms, state budget ${config.stateBudgetChars} chars)`);
    else console.log("eval: code graders only — set TYPESAFE_API_KEY to enable jev judgments");
    if (judge) console.log(escalator ? `escalation: on (${escalator.model} when jev confidence < ${config.reviewConfidence})` : "escalation: off — set ANTHROPIC_API_KEY to get rationales on low-confidence judgments");
    if (judge) console.log(`per-step grading: on (concurrency ${config.stepConcurrency}, max ${config.stepMaxPerTrace} steps/trace) — disable the \`step\` evaluator to turn it off`);
    console.log(compiler ? `rubric compiler: on (${compiler.model}) — POST /api/v1/evaluators/compile` : "rubric compiler: off — set ANTHROPIC_API_KEY to compile natural-language rubrics into jev questions");
    console.log(
      langfuse
        ? `langfuse: pulling ${config.langfuse.host} every ${config.langfuse.pollMs}ms (settle ${config.langfuse.settleS}s), write-back ${config.langfuse.writeBack ? "on" : "off"}${config.langfuse.reviewQueueId ? `, review queue ${config.langfuse.reviewQueueId}` : ""}`
        : "langfuse: off — set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY to pull traces and write scores back",
    );
    console.log(`jev budget: ${config.jevRpm} req/min, ${config.jevConcurrency} in flight${config.dailyBudgetUsd ? `, $${config.dailyBudgetUsd}/day` : ""}`);
  });
}
