// Minimal server-rendered UI. No build step, no client framework: three pages
// (trace list, trace detail, evaluators) plus a dashboard header. Everything
// jev returns is a probability, so answers render as bars, not prose.
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Repo, ScoreRow, ObservationRow, JudgmentRow, TraceRow } from "../db/repo.js";

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
form.inline{display:inline}button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}button:hover{border-color:var(--accent)}
`;

function layout(title: string, body: unknown, stats: { traces: number; cost: number; queue: Record<string, number> }) {
  const pending = (stats.queue.pending ?? 0) + (stats.queue.running ?? 0);
  return html`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · openeva</title><style>${raw(CSS)}</style></head>
<body><header><b><a href="/" style="color:inherit">openeva</a></b><nav><a href="/">Traces</a><a href="/evaluators">Evaluators</a><a href="/datasets">Datasets</a><a href="/api/v1/stats">API</a></nav>
<span class="stats">${stats.traces} traces · eval spend $${stats.cost.toFixed(4)}${pending ? ` · ${pending} queued` : ""}</span></header>
<main>${body}</main></body></html>`;
}

function scoreBadges(scores: ScoreRow[]) {
  const evalScores = scores.filter((s) => s.source === "EVAL");
  const byName = new Map(evalScores.map((s) => [s.name, s]));
  const out: string[] = [];
  const pass = byName.get("passed");
  if (pass) out.push(`<span class="badge ${pass.value ? "ok" : "bad"}">${pass.value ? "PASS" : "FAIL"}</span>`);
  const q = byName.get("trajectory_quality");
  if (q?.value != null) out.push(`<span class="badge">quality ${q.value.toFixed(2)}</span>`);
  const oq = byName.get("outcome_quality");
  if (oq?.value != null) out.push(`<span class="badge">outcome ${oq.value.toFixed(2)}</span>`);
  const fm = byName.get("failure_mode");
  if (fm?.string_value && fm.string_value !== "none") out.push(`<span class="badge warn">${esc(fm.string_value)}</span>`);
  const tc = byName.get("task_completion");
  if (tc?.value != null) out.push(`<span class="badge">completion ${tc.value.toFixed(1)}/2</span>`);
  for (const s of scores.filter((s) => s.source !== "EVAL")) {
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
        return `<div class="step" style="margin-left:${depth(o) * 18}px"><div class="hd"><span class="type ${esc(o.type)}">${esc(o.type)}</span><b>${esc(o.name ?? "")}</b>${o.model ? `<span class="muted mono">${esc(o.model)}</span>` : ""}<span class="muted">${fmtMs(dur)}</span>${usage}${o.level !== "DEFAULT" ? `<span class="lvl-${esc(o.level)}">${esc(o.level)}${o.status_message ? ": " + esc(o.status_message) : ""}</span>` : ""}</div>${sc ? `<div>${sc}</div>` : ""}${io}</div>`;
      })
      .join(""),
  );
}

function judgmentView(jd: JudgmentRow, evName: string, obsName?: string | null) {
  const title = `${esc(evName)}${obsName ? ` <span class="muted">@ ${esc(obsName)}</span>` : ""}`;
  if (jd.status === "error") {
    return `<div class="card"><h2>${title} · <span class="lvl-ERROR">error</span>${jd.escalated_from ? " (escalation)" : ""}</h2><pre class="mono">${esc(jd.error)}</pre></div>`;
  }
  const answers = (jd.answers ?? {}) as Record<string, Record<string, unknown>>;
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
  return `<div class="card"><h2>${title} <span class="muted">v${jd.evaluator_version} · ${esc(jd.model)} · ${fmtMs(jd.latency_ms)} · ${jd.usage_input} tok · $${(jd.cost_usd ?? 0).toFixed(6)}${jd.needs_review ? ' · <span class="lvl-WARNING">needs review</span>' : ""}${escLabel}</span></h2>
    ${parts.join("")}
    <details style="margin-top:8px"><summary>state sent to jev (${meta.chars ?? "?"} chars${meta.truncated ? ", truncated" : ""})</summary><pre class="mono">${esc(pretty(jd.state))}</pre></details>
    <details><summary>questions</summary><pre class="mono">${esc(pretty(jd.questions))}</pre></details></div>`;
}

function bar(label: string, p: number, hl = false) {
  const pct = Math.max(0, Math.min(100, p * 100));
  return `<div class="bar"><span class="lbl" title="${esc(label)}">${hl ? "<b>" : ""}${esc(label.length > 70 ? label.slice(0, 68) + "…" : label)}${hl ? "</b>" : ""}</span><div class="trk"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div><span class="val mono">${(p * 100).toFixed(0)}%</span></div>`;
}

export function uiRoutes(repo: Repo): Hono {
  const app = new Hono();
  const stats = () => ({ traces: repo.countTraces(), cost: Number(repo.judgmentStats().cost_usd ?? 0), queue: repo.queueStats() });

  app.get("/", (c) => {
    const q = c.req.query();
    const traces = repo.listTraces({ limit: 100, name: q.name, tag: q.tag, sessionId: q.sessionId });
    const scores = repo.scoresForTraces(traces.map((t) => t.id));
    const rows = traces
      .map((t: TraceRow) => {
        const s = scores.get(t.id) ?? [];
        return `<tr><td class="mono muted">${fmtTs(t.timestamp)}</td><td><a href="/traces/${esc(t.id)}">${esc(t.name ?? t.id.slice(0, 8))}</a>${t.tags?.length ? `<br>${t.tags.map((x) => `<span class="badge muted">${esc(x)}</span>`).join("")}` : ""}</td>
        <td class="muted mono">${esc(t.session_id ?? "")}</td><td class="mono muted" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pretty(t.input)).slice(0, 120)}</td><td>${scoreBadges(s)}</td></tr>`;
      })
      .join("");
    const body = html`<h1>Traces</h1>
      <table><thead><tr><th>Time</th><th>Name</th><th>Session</th><th>Input</th><th>Scores</th></tr></thead>
      <tbody>${raw(rows || `<tr><td colspan="5" class="muted">No traces yet. Point a Langfuse SDK at this server or run <code>pnpm demo</code>.</td></tr>`)}</tbody></table>`;
    return c.html(layout("Traces", body, stats()));
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
      <div class="muted" style="margin-bottom:12px">${fmtTs(t.timestamp)} ${t.session_id ? `· session <span class="mono">${esc(t.session_id)}</span>` : ""} ${t.user_id ? `· user <span class="mono">${esc(t.user_id)}</span>` : ""} · ${obs.length} steps
        <form class="inline" method="post" action="/traces/${esc(t.id)}/evaluate"><button>re-evaluate now</button></form>
        <form class="inline" method="post" action="/traces/${esc(t.id)}/escalate"><button>second opinion (reasoning model)</button></form></div>
      <div class="grid">
        <div>
          <div class="card"><h2>Input</h2><pre class="mono">${esc(pretty(t.input))}</pre></div>
          <div class="card"><h2>Output</h2><pre class="mono">${esc(pretty(t.output))}</pre></div>
          ${t.expected_output !== null && t.expected_output !== undefined ? raw(`<div class="card"><h2>Expected output</h2><pre class="mono">${esc(pretty(t.expected_output))}</pre></div>`) : ""}
          <div class="card"><h2>Scores</h2><table><thead><tr><th>Name</th><th class="right">Value</th><th>Source</th><th>Comment</th></tr></thead><tbody>${raw(scoreRows || '<tr><td colspan="4" class="muted">none yet</td></tr>')}</tbody></table></div>
          ${raw([...latest.values()].map((jd) => judgmentView(jd, evNames.get(jd.evaluator_id) ?? jd.evaluator_id, jd.observation_id ? obsNames.get(jd.observation_id) ?? jd.observation_id : null)).join(""))}
        </div>
        <div><div class="card"><h2>Trajectory</h2>${obsTree(obs, scores)}</div>
          ${t.metadata ? raw(`<div class="card"><h2>Metadata</h2><pre class="mono">${esc(pretty(t.metadata))}</pre></div>`) : ""}</div>
      </div>`;
    return c.html(layout(t.name ?? "trace", body, stats()));
  });

  app.get("/evaluators", (c) => {
    const evs = repo.listEvaluators();
    const cards = evs
      .map(
        (e) => `<div class="card"><h2>${esc(e.name)} <span class="muted">v${e.version}${e.builtin ? " · builtin" : ""} · ${e.target === "observation" ? "per observation" : "per trace"} · ${e.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge bad">disabled</span>'}</span>
          <form class="inline" method="post" action="/evaluators/${esc(e.id)}/toggle"><button>${e.enabled ? "disable" : "enable"}</button></form></h2>
          <p>${esc(e.description ?? "")}</p>
          ${e.filter ? `<p class="muted mono">filter: ${esc(JSON.stringify(e.filter))}</p>` : ""}
          <details><summary>${Object.keys(e.questions).length} questions</summary><pre class="mono">${esc(pretty(e.questions))}</pre></details>
          ${e.composite ? `<details><summary>composite</summary><pre class="mono">${esc(pretty(e.composite))}</pre></details>` : ""}</div>`,
      )
      .join("");
    const body = html`<h1>Evaluators</h1><p class="muted">Each evaluator is one jev request per trace: every question below is asked in parallel against the same compacted trajectory. Create custom ones via <code>POST /api/v1/evaluators</code>.</p>${raw(cards)}`;
    return c.html(layout("Evaluators", body, stats()));
  });

  app.get("/datasets", (c) => {
    const ds = repo.listDatasets();
    const rows = ds
      .map((d) => {
        const runs = repo.listRuns(d.id as string);
        const runRows = runs
          .map(
            (r) =>
              `<tr><td class="mono">${esc(r.run_name)}</td><td class="right">${r.n}</td><td class="right">${r.avg_quality != null ? Number(r.avg_quality).toFixed(2) : "–"}</td><td class="right">${r.pass_rate != null ? (Number(r.pass_rate) * 100).toFixed(0) + "%" : "–"}</td><td class="muted mono">${fmtTs(String(r.started_at))}</td></tr>`,
          )
          .join("");
        return `<div class="card"><h2>${esc(d.name)} <span class="muted">${d.item_count} items</span></h2><p class="muted">${esc(d.description ?? "")}</p>
          <table><thead><tr><th>Run</th><th class="right">Traces</th><th class="right">Avg quality</th><th class="right">Pass rate</th><th>Started</th></tr></thead><tbody>${runRows || '<tr><td colspan="5" class="muted">no runs</td></tr>'}</tbody></table></div>`;
      })
      .join("");
    return c.html(layout("Datasets", html`<h1>Datasets</h1>${raw(rows || '<p class="muted">No datasets. Create one via <code>POST /api/v1/datasets</code>.</p>')}`, stats()));
  });

  // tiny form handlers (redirect back)
  app.post("/evaluators/:id/toggle", (c) => {
    const e = repo.getEvaluator(c.req.param("id"));
    if (e) repo.setEvaluatorEnabled(e.id, !e.enabled);
    return c.redirect("/evaluators");
  });

  return app;
}
