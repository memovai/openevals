// Minimal server-rendered UI. No build step, no client framework: three pages
// (trace list, trace detail, evaluators) plus a dashboard header. Everything
// jev returns is a probability, so answers render as bars, not prose.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Repo, ScoreRow, ObservationRow, JudgmentRow, TraceRow } from "../db/repo.js";
import { runReport, calibration } from "../eval/metrics.js";
import { config } from "../config.js";
import { questionDiagnostics } from "../eval/diagnostics.js";
import { lintEvaluator } from "../eval/lint.js";
import { templates } from "../eval/templates.js";
import { summarizeSteps } from "../eval/steps.js";
import { jevLimiter } from "../eval/jev.js";
import type { LangfuseSync } from "../sources/langfuse/sync.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pretty = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
const fmtMs = (ms: number | null | undefined) => (ms == null ? "–" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTs = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");

const CSS = `
:root{--bg:#fafafa;--fg:#1a1a1a;--muted:#6b7280;--card:#fff;--line:#e5e7eb;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--accent:#2563eb;--bar:#dbeafe}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--muted:#9ca3af;--card:#171a21;--line:#2a2f3a;--bar:#1e3a5f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:18px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:16px}header nav a{margin-right:14px}header .stats{margin-left:auto;color:var(--muted);font-size:12px}
main{padding:20px;max-width:1280px;margin:0 auto}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.muted{color:var(--muted)}.right{text-align:right}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:var(--card);margin:1px 2px 1px 0;white-space:nowrap}
.badge.ok{border-color:var(--ok);color:var(--ok)}.badge.bad{border-color:var(--bad);color:var(--bad)}.badge.warn{border-color:var(--warn);color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
pre{margin:0;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;max-height:320px;overflow:auto}
details summary{cursor:pointer;color:var(--muted)}
.step{border-left:2px solid var(--line);padding:6px 10px;margin:4px 0}.step .hd{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.type{font-size:11px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:4px;background:var(--bar)}
.type.GENERATION{background:#fef3c7;color:#92400e}.type.TOOL{background:#dcfce7;color:#166534}.type.EVENT{background:#f3e8ff;color:#6b21a8}.type.AGENT{background:#e0f2fe;color:#075985}
.lvl-ERROR{color:var(--bad);font-weight:600}.lvl-WARNING{color:var(--warn)}
.bar{display:flex;align-items:center;gap:8px;margin:2px 0}.bar .lbl{min-width:220px;font-size:12px}.bar .trk{flex:1;height:10px;background:var(--bar);border-radius:5px;overflow:hidden}.bar .fill{height:100%;background:var(--accent)}.bar .val{min-width:44px;text-align:right;font-size:12px}
.q{padding:8px 0;border-bottom:1px dashed var(--line)}.q:last-child{border-bottom:0}.q .qh{display:flex;justify-content:space-between;gap:10px}.q .qh b{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.strip{display:flex;gap:2px;flex-wrap:wrap;margin:6px 0}.strip a{display:block;width:14px;height:14px;border-radius:3px;background:var(--line)}.strip a.p2{background:var(--ok)}.strip a.p1{background:var(--warn)}.strip a.p0{background:var(--bad)}.strip a.off{outline:2px solid var(--bad);outline-offset:-2px}
.lint{margin:6px 0 0;padding-left:18px;font-size:12px}.lint li{margin:2px 0}.lint .error{color:var(--bad)}.lint .warn{color:var(--warn)}.lint .info{color:var(--muted)}
form.inline{display:inline}button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}button:hover{border-color:var(--accent)}
`;

function layout(title: string, body: unknown, stats: { traces: number; cost: number; queue: Record<string, number> }) {
  const pending = (stats.queue.pending ?? 0) + (stats.queue.running ?? 0);
  return html`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · openevals</title><style>${raw(CSS)}</style></head>
<body><header><b><a href="/" style="color:inherit">openevals</a></b><nav><a href="/">Status</a><a href="/evaluators">Evaluators</a><a href="/calibration">Calibration</a><a href="/review">Review</a><a href="/traces">Judgments</a><a href="/api/v1/sync">API</a></nav>
<span class="stats">${stats.traces} traces · eval spend $${stats.cost.toFixed(4)}${pending ? ` · ${pending} queued` : ""}</span></header>
<main>${body}</main></body></html>`;
}

function scoreBadges(scores: ScoreRow[]) {
  const evalScores = scores.filter((s) => s.source === "EVAL");
  const byName = new Map(evalScores.map((s) => [s.name, s]));
  const out: string[] = [];
  const passes = evalScores.filter((s) => s.name === "passed");
  if (passes.length) {
    const ok = passes.every((p) => (p.value ?? 0) >= 0.5);
    out.push(`<span class="badge ${ok ? "ok" : "bad"}">${ok ? "PASS" : "FAIL"}</span>`);
  }
  const human = scores.find((s) => s.source === "ANNOTATION" && s.name === "passed");
  if (human) out.push(`<span class="badge ${human.value ? "ok" : "bad"}">human ${human.value ? "pass" : "fail"}</span>`);
  const q = byName.get("trajectory_quality");
  if (q?.value != null) out.push(`<span class="badge">quality ${q.value.toFixed(2)}</span>`);
  const oq = byName.get("outcome_quality");
  if (oq?.value != null) out.push(`<span class="badge">outcome ${oq.value.toFixed(2)}</span>`);
  const fm = byName.get("failure_mode");
  if (fm?.string_value && fm.string_value !== "none") out.push(`<span class="badge warn">${esc(fm.string_value)}</span>`);
  const tc = byName.get("task_completion");
  if (tc?.value != null) out.push(`<span class="badge">completion ${tc.value.toFixed(1)}/2</span>`);
  for (const s of scores.filter((s) => s.source !== "EVAL" && s.name !== "passed")) {
    out.push(`<span class="badge muted">${esc(s.name)}: ${s.string_value ?? s.value}</span>`);
  }
  return raw(out.join(""));
}

function obsTree(obs: ObservationRow[], scores: ScoreRow[] = []) {
  const byId = new Map(obs.map((o) => [o.id, o]));
  const scoresByObs = new Map<string, ScoreRow[]>();
  for (const s of scores) if (s.observation_id) scoresByObs.set(s.observation_id, [...(scoresByObs.get(s.observation_id) ?? []), s]);
  const depth = (o: ObservationRow) => {
    let d = 0,
      cur = o;
    while (cur.parent_observation_id && byId.has(cur.parent_observation_id) && d < 32) {
      cur = byId.get(cur.parent_observation_id)!;
      d++;
    }
    return d;
  };
  return raw(
    obs
      .map((o) => {
        const dur = o.end_time ? Date.parse(o.end_time) - Date.parse(o.start_time) : null;
        const io = [
          o.input !== null && o.input !== undefined ? `<details><summary>input</summary><pre class="mono">${esc(pretty(o.input))}</pre></details>` : "",
          o.output !== null && o.output !== undefined ? `<details><summary>output</summary><pre class="mono">${esc(pretty(o.output))}</pre></details>` : "",
        ].join("");
        const usage = o.usage_total != null ? `<span class="muted mono">${o.usage_total} tok</span>` : "";
        const sc = (scoresByObs.get(o.id) ?? [])
          .map((s) => `<span class="badge${s.data_type === "BOOLEAN" ? (s.value ? " ok" : " bad") : ""}" title="${esc(s.comment ?? "")}">${esc(s.name)} ${s.string_value ?? (s.value != null ? s.value.toFixed(2) : "")}</span>`)
          .join("");
        return `<div class="step" id="obs-${esc(o.id)}" style="margin-left:${depth(o) * 18}px"><div class="hd"><span class="type ${esc(o.type)}">${esc(o.type)}</span><b>${esc(o.name ?? "")}</b>${o.model ? `<span class="muted mono">${esc(o.model)}</span>` : ""}<span class="muted">${fmtMs(dur)}</span>${usage}${o.level !== "DEFAULT" ? `<span class="lvl-${esc(o.level)}">${esc(o.level)}${o.status_message ? ": " + esc(o.status_message) : ""}</span>` : ""}</div>${sc ? `<div>${sc}</div>` : ""}${io}</div>`;
      })
      .join(""),
  );
}

/** One square per step coloured by the per-step `progress` answer (green progress · amber none · red regressed); off-task steps outlined. */
function progressStrip(obs: ObservationRow[], scores: ScoreRow[]) {
  const byObs = new Map<string, Map<string, ScoreRow>>();
  for (const s of scores) if (s.source === "EVAL" && s.observation_id) byObs.set(s.observation_id, new Map([...(byObs.get(s.observation_id) ?? new Map()), [s.name, s]]));
  if (![...byObs.values()].some((m) => m.has("progress"))) return raw("");
  const sum = summarizeSteps(obs, scores);
  const cells = obs
    .map((o, i) => {
      const m = byObs.get(o.id);
      const p = m?.get("progress");
      const cls = p?.value == null ? "" : `p${Math.round(p.value)}`;
      const off = (m?.get("on_task")?.value ?? 1) < 0.5 ? " off" : "";
      const title = `#${i} ${o.name ?? o.type}${p?.value != null ? ` · progress ${p.value.toFixed(1)}` : ""}${off ? " · off task" : ""}`;
      return `<a class="${cls}${off}" href="#obs-${esc(o.id)}" title="${esc(title)}"></a>`;
    })
    .join("");
  const f = (v: number | null) => (v == null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(2));
  return raw(`<div class="strip">${cells}</div><div class="muted" style="font-size:12px;margin-bottom:8px">per-step: progress ${f(sum.progress_mean)} · wasted ${f(sum.wasted_fraction)} · longest stall ${f(sum.longest_stall)} · first off-task ${sum.first_off_task_step == null ? "none" : "#" + sum.first_off_task_step}${sum.errors ? ` · recovered ${sum.errors_recovered ?? 0}/${sum.errors} errors` : ""}</div>`);
}

function judgmentView(jd: JudgmentRow, evName: string, obsName?: string | null) {
  const title = `${esc(evName)}${obsName ? ` <span class="muted">@ ${esc(obsName)}</span>` : ""}`;
  if (jd.status === "error") {
    return `<div class="card"><h2>${title} · <span class="lvl-ERROR">error</span>${jd.escalated_from ? " (escalation)" : ""}</h2><pre class="mono">${esc(jd.error)}</pre></div>`;
  }
  const answers = (jd.answers ?? {}) as Record<string, Record<string, unknown>>;
  if (jd.model === "code") {
    const rows = Object.values(answers)
      .map((r) => `<tr><td class="mono">${esc(r.name)}</td><td>${r.passed ? '<span class="badge ok">pass</span>' : '<span class="badge bad">fail</span>'}</td><td class="muted">${esc(r.detail)}</td></tr>`)
      .join("");
    return `<div class="card"><h2>${title} <span class="muted">code grader · free</span></h2><table><tbody>${rows}</tbody></table>
      <details style="margin-top:8px"><summary>measured features</summary><pre class="mono">${esc(pretty(jd.state))}</pre></details></div>`;
  }
  const qs = jd.questions as Record<string, { criteria?: unknown }>;
  const rat = jd.rationales ?? {};
  const why = (id: string) => (rat[id] ? `<div class="muted" style="margin:2px 0 4px">${esc(rat[id])}</div>` : "");
  const parts: string[] = [];
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === "noul") {
      const p = Number(a.noul);
      parts.push(`<div class="q"><div class="qh"><b>${esc(id)}</b><span class="muted">noul · P(yes)</span></div>${why(id)}${bar("yes", p)}</div>`);
    } else if (a.type === "score") {
      const probs = a.probabilities as Record<string, number>;
      const legend = (a.legend ?? {}) as Record<string, string>;
      const rows = Object.entries(probs)
        .sort(([x], [y]) => Number(x) - Number(y))
        .map(([lvl, p]) => bar(`${lvl}: ${typeof legend[lvl] === "string" ? legend[lvl] : ""}`, p))
        .join("");
      parts.push(`<div class="q"><div class="qh"><b>${esc(id)}</b><span class="muted">score ${Number(a.score).toFixed(2)} · conf ${Number(a.confidence).toFixed(2)}</span></div>${why(id)}${rows}</div>`);
    } else if (a.type === "choice") {
      const probs = a.probabilities as Record<string, number>;
      const crit = (qs[id]?.criteria ?? {}) as Record<string, unknown>;
      const rows = Object.entries(probs)
        .sort(([, x], [, y]) => y - x)
        .map(([opt, p]) => bar(`${opt}${typeof crit[opt] === "string" ? " — " + crit[opt] : ""}`, p, opt === a.choice))
        .join("");
      parts.push(`<div class="q"><div class="qh"><b>${esc(id)}</b><span class="muted">choice → <b>${esc(a.choice)}</b> · conf ${Number(a.confidence).toFixed(2)}</span></div>${why(id)}${rows}</div>`);
    }
  }
  const meta = jd.state_meta ?? {};
  const escLabel = jd.escalated_from ? ' · <span class="badge warn">escalated</span>' : "";
  return `<div class="card" id="judgment-${esc(jd.id)}"><h2>${title} <span class="muted">v${jd.evaluator_version} · ${esc(jd.model)} · ${fmtMs(jd.latency_ms)} · ${jd.usage_input} tok · $${(jd.cost_usd ?? 0).toFixed(6)}${jd.needs_review ? ' · <span class="lvl-WARNING">needs review</span>' : ""}${escLabel}</span></h2>
    ${parts.join("")}
    <details style="margin-top:8px"><summary>state sent to jev (${meta.chars ?? "?"} chars${meta.truncated ? ", truncated" : ""})</summary><pre class="mono">${esc(pretty(jd.state))}</pre></details>
    <details><summary>questions</summary><pre class="mono">${esc(pretty(jd.questions))}</pre></details></div>`;
}

function bar(label: string, p: number, hl = false) {
  const pct = Math.max(0, Math.min(100, p * 100));
  return `<div class="bar"><span class="lbl" title="${esc(label)}">${hl ? "<b>" : ""}${esc(label.length > 70 ? label.slice(0, 68) + "…" : label)}${hl ? "</b>" : ""}</span><div class="trk"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div><span class="val mono">${(p * 100).toFixed(0)}%</span></div>`;
}

export function uiRoutes(repo: Repo, opts: { langfuse?: LangfuseSync | null } = {}): Hono {
  const app = new Hono();
  const langfuse = opts.langfuse ?? null;
  const stats = () => ({ traces: repo.countTraces(), cost: Number(repo.judgmentStats().cost_usd ?? 0), queue: repo.queueStats() });

  /** Home: what the online-eval loop is doing right now. */
  app.get("/", (c) => {
    const st = langfuse ? langfuse.status() : null;
    const startOfDay = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const spent = repo.judgmentCostSince(startOfDay);
    const lim = jevLimiter.stats;
    const js = repo.judgmentStats();
    const kv = (rows: [string, unknown][]) =>
      `<table><tbody>${rows.map(([k, v]) => `<tr><td class="muted" style="width:45%">${esc(k)}</td><td class="mono">${esc(v == null ? "–" : String(v))}</td></tr>`).join("")}</tbody></table>`;
    const recent = repo.recentlyJudged(25);
    const scores = repo.scoresForTraces(recent.map((t) => t.id));
    const rows = recent
      .map((t) => {
        const s = scores.get(t.id) ?? [];
        return `<tr><td class="mono muted">${fmtTs(t.timestamp)}</td><td><a href="/traces/${esc(t.id)}">${esc(t.name ?? t.id.slice(0, 8))}</a>${t.external_url ? ` <a class="muted" href="${esc(t.external_url)}" target="_blank" rel="noopener">↗ ${esc(t.source)}</a>` : ""}</td><td>${scoreBadges(s)}</td></tr>`;
      })
      .join("");
    const source = st
      ? `<div class="card"><h2>Langfuse connector</h2>${kv([
          ["host", st.host],
          ["last poll", st.last_poll_at],
          ["watermark", st.watermark],
          ["observations pulled", st.observations_pulled],
          ["traces pulled", st.traces_pulled],
          ["scores written back", st.scores_written],
          ["scores rejected", st.scores_rejected],
          ["pending write-back", st.unsynced_scores],
          ["annotations pulled", st.annotations_pulled],
          ["review queue", st.review_queue],
          ["last poll error", st.last_poll_error],
          ["last write-back error", st.last_write_back_error],
        ])}
        <form class="inline" method="post" action="/sync/poll" style="margin-top:8px"><button>poll now</button></form>
        <form class="inline" method="post" action="/sync/writeback"><button>write back now</button></form>
        <form class="inline" method="post" action="/sync/annotations"><button>pull annotations</button></form></div>`
      : `<div class="card"><h2>Source</h2><p class="muted">No Langfuse connector configured. Set <code>LANGFUSE_HOST</code>, <code>LANGFUSE_PUBLIC_KEY</code>, <code>LANGFUSE_SECRET_KEY</code> to pull traces from Langfuse and write scores back. Traces sent directly to this server (Langfuse SDK / OTLP / built-in SDK) are still graded.</p></div>`;
    const body = html`<h1>Online eval</h1>
      <div class="grid">
        <div>${raw(source)}</div>
        <div><div class="card"><h2>jev budget</h2>${raw(
          kv([
            ["requests last minute", `${lim.last_minute} / ${lim.rpm}`],
            ["in flight", `${lim.in_flight} / ${lim.concurrency}`],
            ["waiting", lim.waiting],
            ["spent today", `$${spent.toFixed(4)}${config.dailyBudgetUsd ? ` / $${config.dailyBudgetUsd}` : ""}`],
            ["judgments total", js.n],
            ["spend total", `$${Number(js.cost_usd ?? 0).toFixed(4)}`],
            ["avg latency", fmtMs(js.avg_latency_ms)],
            ["needs review", js.needs_review],
            ["queue", JSON.stringify(repo.queueStats())],
          ]),
        )}</div></div>
      </div>
      <div class="card"><h2>Recently judged</h2><table><thead><tr><th>Time</th><th>Trace</th><th>Scores</th></tr></thead><tbody>${raw(rows || '<tr><td colspan="3" class="muted">nothing judged yet</td></tr>')}</tbody></table></div>`;
    return c.html(layout("Status", body, stats()));
  });

  app.get("/traces", (c) => {
    const q = c.req.query();
    const traces = repo.listTraces({ limit: 100, name: q.name, tag: q.tag, sessionId: q.sessionId });
    const scores = repo.scoresForTraces(traces.map((t) => t.id));
    const rows = traces
      .map((t: TraceRow) => {
        const s = scores.get(t.id) ?? [];
        return `<tr><td class="mono muted">${fmtTs(t.timestamp)}</td><td><a href="/traces/${esc(t.id)}">${esc(t.name ?? t.id.slice(0, 8))}</a>${t.external_url ? ` <a class="muted" href="${esc(t.external_url)}" target="_blank" rel="noopener">↗</a>` : ""}${t.tags?.length ? `<br>${t.tags.map((x) => `<span class="badge muted">${esc(x)}</span>`).join("")}` : ""}</td>
        <td class="muted mono">${esc(t.session_id ?? "")}</td><td class="mono muted" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pretty(t.input)).slice(0, 120)}</td><td>${scoreBadges(s)}</td></tr>`;
      })
      .join("");
    const body = html`<h1>Judgments</h1><p class="muted">Every trace this server has graded. Traces pulled from Langfuse link back to it; the judgment detail (state sent to jev, probability per question) lives here.</p>
      <table><thead><tr><th>Time</th><th>Name</th><th>Session</th><th>Input</th><th>Scores</th></tr></thead>
      <tbody>${raw(rows || `<tr><td colspan="5" class="muted">No traces yet. Point a Langfuse SDK at this server or run <code>pnpm demo</code>.</td></tr>`)}</tbody></table>`;
    return c.html(layout("Judgments", body, stats()));
  });

  app.get("/traces/:id", (c) => {
    const t = repo.getTrace(c.req.param("id"));
    if (!t) return c.notFound();
    const obs = repo.listObservations(t.id);
    const scores = repo.listScores(t.id);
    const judgments = repo.listJudgments(t.id);
    const evNames = new Map(repo.listEvaluators().map((e) => [e.id, e.name]));
    const obsNames = new Map(obs.map((o) => [o.id, o.name ?? o.type]));
    // latest judgment per (evaluator, observation); judgments are newest-first so escalations come first
    const latest = new Map<string, JudgmentRow>();
    for (const jd of judgments) {
      const key = `${jd.evaluator_id}:${jd.observation_id ?? ""}`;
      if (!latest.has(key)) latest.set(key, jd);
    }
    const scoreRows = scores
      .map(
        (s) =>
          `<tr><td class="mono">${esc(s.name)}${s.observation_id ? `<br><span class="muted">@ ${esc(obsNames.get(s.observation_id) ?? s.observation_id)}</span>` : ""}</td><td class="right mono">${s.string_value ?? (s.value != null ? (s.data_type === "BOOLEAN" ? (s.value ? "true" : "false") : s.value.toFixed(3)) : "")}</td><td class="muted">${esc(s.source)}${s.metadata?.escalated ? '<br><span class="badge warn">escalated</span>' : ""}</td><td class="muted">${esc(s.comment ?? "")}</td></tr>`,
      )
      .join("");
    const body = html`<h1>${esc(t.name ?? "trace")} <span class="muted mono" style="font-size:12px">${esc(t.id)}</span></h1>
      <div class="muted" style="margin-bottom:12px">${fmtTs(t.timestamp)} ${t.external_url ? raw(`· <a href="${esc(t.external_url)}" target="_blank" rel="noopener">open in ${esc(t.source)} ↗</a>`) : ""} ${t.session_id ? `· session <span class="mono">${esc(t.session_id)}</span>` : ""} ${t.user_id ? `· user <span class="mono">${esc(t.user_id)}</span>` : ""} · ${obs.length} steps
        <form class="inline" method="post" action="/traces/${esc(t.id)}/evaluate"><button>re-evaluate now</button></form>
        <form class="inline" method="post" action="/traces/${esc(t.id)}/escalate"><button>second opinion (reasoning model)</button></form></div>
      <div class="grid">
        <div>
          <div class="card"><h2>Input</h2><pre class="mono">${esc(pretty(t.input))}</pre></div>
          <div class="card"><h2>Output</h2><pre class="mono">${esc(pretty(t.output))}</pre></div>
          ${t.expected_output !== null && t.expected_output !== undefined ? raw(`<div class="card"><h2>Expected output</h2><pre class="mono">${esc(pretty(t.expected_output))}</pre></div>`) : ""}
          <div class="card"><h2>Scores</h2><table><thead><tr><th>Name</th><th class="right">Value</th><th>Source</th><th>Comment</th></tr></thead><tbody>${raw(scoreRows || '<tr><td colspan="4" class="muted">none yet</td></tr>')}</tbody></table></div>
          ${t.source === "langfuse"
            ? raw(`<div class="card"><h2>Human verdict</h2><p class="muted" style="margin:0">Annotate this trace in Langfuse${t.external_url ? ` (<a href="${esc(t.external_url)}" target="_blank" rel="noopener">open ↗</a>)` : ""}; a score named <code>${esc(config.langfuse.verdictScore)}</code> is pulled back as the human verdict for <a href="/calibration">calibration</a>.</p></div>`)
            : raw(`<div class="card"><h2>Human verdict</h2><p class="muted" style="margin:0 0 8px">Your call becomes an ANNOTATION score named <code>passed</code>; it feeds the <a href="/calibration">calibration</a> report against the model graders.</p>
            <form method="post" action="/traces/${esc(t.id)}/annotate" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <button name="verdict" value="1">✓ pass</button><button name="verdict" value="0">✗ fail</button>
              <input name="comment" placeholder="why (optional)" style="flex:1;min-width:200px;font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)">
            </form></div>`)}
          ${raw([...latest.values()].map((jd) => judgmentView(jd, evNames.get(jd.evaluator_id) ?? jd.evaluator_id, jd.observation_id ? obsNames.get(jd.observation_id) ?? jd.observation_id : null)).join(""))}
        </div>
        <div><div class="card"><h2>Trajectory</h2>${progressStrip(obs, scores)}${obsTree(obs, scores)}</div>
          ${t.metadata ? raw(`<div class="card"><h2>Metadata</h2><pre class="mono">${esc(pretty(t.metadata))}</pre></div>`) : ""}</div>
      </div>`;
    return c.html(layout(t.name ?? "trace", body, stats()));
  });

  app.get("/evaluators", (c) => {
    const evs = repo.listEvaluators();
    const cards = evs
      .map((e) => {
        const lint = lintEvaluator({ kind: e.kind, target: e.target, filter: e.filter, questions: e.questions, composite: e.composite });
        const lintHtml = lint.length
          ? `<details><summary>lint: ${lint.filter((x) => x.level === "error").length} errors · ${lint.filter((x) => x.level === "warn").length} warnings · ${lint.filter((x) => x.level === "info").length} notes</summary><ul class="lint">${lint.map((x) => `<li class="${x.level}"><b>${esc(x.level)}</b> ${x.question ? `<span class="mono">${esc(x.question)}</span> ` : ""}${esc(x.message)}${x.fix ? ` <span class="muted">→ ${esc(x.fix)}</span>` : ""}</li>`).join("")}</ul></details>`
          : `<p class="muted" style="font-size:12px;margin:6px 0 0">lint: clean</p>`;
        return `<div class="card"><h2>${esc(e.name)} <span class="muted">v${e.version}${e.builtin ? " · builtin" : ""} · ${e.kind === "code" ? "code grader" : "jev"} · ${e.target === "observation" ? "per step" : "per trace"} · ${e.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge bad">disabled</span>'}</span>
          <form class="inline" method="post" action="/evaluators/${esc(e.id)}/toggle"><button>${e.enabled ? "disable" : "enable"}</button></form></h2>
          <p>${esc(e.description ?? "")}</p>
          ${e.filter ? `<p class="muted mono">filter: ${esc(JSON.stringify(e.filter))}</p>` : ""}
          <details><summary>${e.kind === "code" ? `${((e.questions as { checks?: unknown[] }).checks ?? []).length} checks` : `${Object.keys(e.questions).length} questions`}</summary><pre class="mono">${esc(pretty(e.questions))}</pre></details>
          ${e.composite ? `<details><summary>composite</summary><pre class="mono">${esc(pretty(e.composite))}</pre></details>` : ""}
          ${lintHtml}</div>`;
      })
      .join("");
    const tpl = templates
      .map((t) => `<tr><td class="mono">${esc(t.id)}</td><td><b>${esc(t.title)}</b><br><span class="muted">${esc(t.description)}</span></td><td class="mono muted">${Object.keys(t.questions).join(", ")}</td></tr>`)
      .join("");
    const body = html`<h1>Evaluators</h1>
      <p class="muted">A jev evaluator is a set of atomic typed questions asked in <b>one request per trace</b> (or per step); weights and pass rules live in <code>composite</code>. Per-step evaluators run concurrently across the steps of a trace and their answers are folded into the trace-level state. Lint flags the ways a rubric written for a text-generating judge fails on jev. See <code>docs/designing-for-jev.md</code>.</p>
      ${raw(cards)}
      <div class="card"><h2>Templates</h2><p class="muted">Starter rubrics already decomposed for jev. Copy one: <code>POST /api/v1/evaluators/from-template {"template":"coding-agent","name":"my-coder","filter":{"names":["my-agent"]}}</code>. Or compile your own rubric from prose: <code>POST /api/v1/evaluators/compile {"name","rubric","save":true}</code> (needs ANTHROPIC_API_KEY).</p>
        <table><thead><tr><th>Template</th><th>For</th><th>Questions</th></tr></thead><tbody>${raw(tpl)}</tbody></table></div>`;
    return c.html(layout("Evaluators", body, stats()));
  });

  app.get("/datasets", (c) => {
    const ds = repo.listDatasets();
    const rows = ds
      .map((d) => {
        const runs = repo.listRuns(d.id as string);
        const pct = (v: number | null | undefined) => (v == null ? "–" : (v * 100).toFixed(0) + "%");
        const runRows = runs
          .map((r) => {
            const rep = runReport(String(r.run_name), repo.runTrials(d.id as string, String(r.run_name)));
            const broken = rep.per_item.filter((i) => i.suspect_broken).length;
            return `<tr><td class="mono"><a href="/api/v1/datasets/${esc(d.name)}/runs/${esc(r.run_name)}">${esc(r.run_name)}</a></td><td class="right">${rep.items}</td><td class="right">${rep.trials_per_item.toFixed(1)}</td><td class="right">${pct(rep.pass_at_1)}</td><td class="right">${pct(rep.pass_at_k)}</td><td class="right">${pct(rep.pass_pow_k)}</td><td class="right">${rep.avg.trajectory_quality != null ? rep.avg.trajectory_quality.toFixed(2) : "–"}</td><td class="right">${broken ? `<span class="badge warn">${broken}</span>` : "0"}</td><td class="muted mono">${fmtTs(String(r.started_at))}</td></tr>`;
          })
          .join("");
        return `<div class="card"><h2>${esc(d.name)} <span class="muted">${d.item_count} items</span></h2><p class="muted">${esc(d.description ?? "")}</p>
          <table><thead><tr><th>Run</th><th class="right">Items</th><th class="right">Trials/item</th><th class="right">pass@1</th><th class="right">pass@k</th><th class="right">pass^k</th><th class="right">Avg quality</th><th class="right">0/k items</th><th>Started</th></tr></thead><tbody>${runRows || '<tr><td colspan="9" class="muted">no runs</td></tr>'}</tbody></table>
          <p class="muted" style="margin:8px 0 0;font-size:12px">pass@k = at least one of k trials passed · pass^k = all k trials passed (k = min trials per item) · 0/k items = never passed across ≥3 trials, usually a broken task rather than a weak agent. Add <code>?compare=&lt;run&gt;</code> to the run JSON for regressions.</p></div>`;
      })
      .join("");
    return c.html(layout("Datasets", html`<h1>Datasets</h1>${raw(rows || '<p class="muted">No datasets. Create one via <code>POST /api/v1/datasets</code>.</p>')}`, stats()));
  });

  app.get("/review", (c) => {
    const q = repo.reviewQueue(200);
    const rows = q
      .map(({ trace, reasons }) => {
        const sc = repo.listScores(trace.id);
        return `<tr><td class="mono muted">${fmtTs(trace.timestamp)}</td><td><a href="/traces/${esc(trace.id)}">${esc(trace.name ?? trace.id.slice(0, 8))}</a></td><td>${reasons.map((r) => `<span class="badge ${r === "annotated" ? "ok" : "warn"}">${esc(r)}</span>`).join("")}</td><td>${scoreBadges(sc)}</td></tr>`;
      })
      .join("");
    const body = html`<h1>Review queue</h1><p class="muted">Traces where the graders were unsure, failed the run, or errored. Read the transcript, then leave a human verdict on the trace page — that is how the model graders get calibrated. "Failures should seem fair."</p>
      <table><thead><tr><th>Time</th><th>Trace</th><th>Why</th><th>Scores</th></tr></thead><tbody>${raw(rows || '<tr><td colspan="4" class="muted">nothing to review</td></tr>')}</tbody></table>`;
    return c.html(layout("Review", body, stats()));
  });

  app.get("/calibration", (c) => {
    const rows = calibration(repo.calibrationPairs());
    const f = (v: number | null) => (v == null ? "–" : v.toFixed(2));
    const tr = rows
      .map(
        (r) =>
          `<tr><td class="mono">${esc(r.name)}</td><td class="right">${r.n}</td><td class="right">${r.agreement == null ? "–" : (r.agreement * 100).toFixed(0) + "%"}</td><td class="right">${f(r.kappa)}</td><td class="right">${f(r.mae)}</td><td class="right">${f(r.pearson_r)}</td><td class="right ${r.false_pass ? "lvl-ERROR" : ""}">${r.false_pass}</td><td class="right">${r.false_fail}</td></tr>`,
      )
      .join("");
    const diags = questionDiagnostics(repo.questionScoreRows());
    const pct = (v: number | null) => (v == null ? "–" : (v * 100).toFixed(0) + "%");
    const dr = diags
      .map((d) => {
        const issues = d.issues.map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join("");
        const sep = d.auc == null ? "–" : `${d.auc.toFixed(2)} <span class="muted">${d.direction === "higher_is_pass" ? "↑ pass" : d.direction === "higher_is_fail" ? "↑ fail" : "none"}</span>`;
        return `<tr><td class="mono"><span class="muted">${esc(d.evaluator)}</span><br>${esc(d.question)}</td><td class="muted">${esc(d.kind)}</td><td class="right">${d.n}<br><span class="muted">${d.n_labeled} labeled</span></td><td class="right">${d.kind === "choice" ? `${esc(d.mode ?? "")} ${pct(d.mode_rate)}` : d.mean == null ? "–" : d.mean.toFixed(2)}</td><td class="right">${pct(d.undecided_rate ?? d.low_confidence_rate)}</td><td class="right">${sep}</td><td class="right ${d.false_pass ? "lvl-ERROR" : ""}">${d.false_pass ?? "–"}</td><td>${issues ? `<ul class="lint" style="margin:0">${issues}</ul>` : '<span class="badge ok">ok</span>'}</td></tr>`;
      })
      .join("");
    const body = html`<h1>Grader calibration</h1><p class="muted">For every score that has both a model (EVAL) and a human (ANNOTATION) value on the same trace. Annotate from the trace page or <code>POST /api/v1/scores</code> with the same score name. <b>false pass</b> = grader said pass, human said fail — the direction that hides real failures.</p>
      <table><thead><tr><th>Score</th><th class="right">n</th><th class="right">Agreement</th><th class="right">κ</th><th class="right">MAE</th><th class="right">Pearson r</th><th class="right">False pass</th><th class="right">False fail</th></tr></thead><tbody>${raw(tr || '<tr><td colspan="8" class="muted">no human annotations yet</td></tr>')}</tbody></table>
      <h2 style="margin-top:24px">Per question: what to rewrite</h2>
      <p class="muted">Every jev question on its own. <b>Unsure</b> = undecided nouls (P(yes) near 0.5) or low-confidence score/choice answers → the criteria are vague. <b>Separation</b> = AUC of the answer against the human verdict (0.5 = no signal) → the question does not track what reviewers check. Questions with the most issues first. Same data as <code>GET /api/v1/calibration/questions</code>; run <code>POST /api/v1/evaluators/:id/backtest</code> after editing a rubric to re-measure on the labeled traces.</p>
      <table><thead><tr><th>Question</th><th>Type</th><th class="right">n</th><th class="right">Mean / mode</th><th class="right">Unsure</th><th class="right">Separation</th><th class="right">False pass</th><th>Diagnosis</th></tr></thead><tbody>${raw(dr || '<tr><td colspan="8" class="muted">no jev judgments yet</td></tr>')}</tbody></table>`;
    return c.html(layout("Calibration", body, stats()));
  });

  app.post("/traces/:id/annotate", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const verdict = form.verdict === "1" ? 1 : form.verdict === "0" ? 0 : null;
    if (verdict !== null && repo.getTrace(id)) {
      repo.db.prepare("DELETE FROM scores WHERE trace_id = ? AND source = 'ANNOTATION' AND name = 'passed' AND observation_id IS NULL").run(id);
      repo.insertScore({ trace_id: id, observation_id: null, name: "passed", value: verdict, string_value: null, data_type: "BOOLEAN", source: "ANNOTATION", comment: typeof form.comment === "string" && form.comment ? form.comment : null, metadata: { via: "ui" }, evaluator_id: null, judgment_id: null });
    }
    return c.redirect(`/traces/${id}`);
  });

  for (const action of ["poll", "writeback", "annotations"] as const) {
    app.post(`/sync/${action}`, async (c) => {
      if (langfuse) {
        try {
          if (action === "poll") await langfuse.pollOnce();
          else if (action === "writeback") await langfuse.writeBackOnce();
          else await langfuse.pullAnnotationsOnce();
        } catch {
          /* surfaced on the status page via sync_state */
        }
      }
      return c.redirect("/");
    });
  }

  // tiny form handlers (redirect back)
  app.post("/evaluators/:id/toggle", (c) => {
    const e = repo.getEvaluator(c.req.param("id"));
    if (e) repo.setEvaluatorEnabled(e.id, !e.enabled);
    return c.redirect("/evaluators");
  });

  return app;
}
