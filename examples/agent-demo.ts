// Emits two synthetic agent trajectories (one good, one that loops and
// fabricates) to a running openevals server, then waits for jev's verdicts.
//   pnpm start            # in one terminal
//   pnpm demo             # in another
import { OpenEvals } from "../src/sdk/index.js";

const base = process.env.OPENEVALS_URL ?? "http://localhost:3100";
const eva = new OpenEvals({ baseUrl: base, flushIntervalMs: 0 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function goodRun() {
  const task = "What was Acme Corp's revenue in Q2 2026 according to the investor letter, and how does it compare to Q1? Answer in one sentence.";
  const t = eva.trace({ name: "research-agent", input: task, sessionId: "demo", tags: ["demo", "good"], expectedOutput: "Q2 2026 revenue was $48.2M, up 12% from $43.0M in Q1." });
  const agent = t.agent({ name: "researcher" });
  const plan = agent.generation({ name: "plan", model: "claude-sonnet-5", input: [{ role: "user", content: task }] });
  await sleep(30);
  plan.end({ output: "I need the Q2 and Q1 figures from the investor letter. I'll search for it.", usage: { input: 210, output: 32 } });
  const search = agent.tool({ name: "search_docs", input: { query: "Acme Corp investor letter Q2 2026 revenue" } });
  await sleep(40);
  search.end({ output: [{ doc: "acme-q2-2026-letter.pdf", snippet: "Revenue for the quarter reached $48.2M, a 12% increase over the $43.0M reported in Q1." }] });
  const answer = agent.generation({ name: "answer", model: "claude-sonnet-5", input: "…context…" });
  await sleep(30);
  const final = "Acme Corp reported Q2 2026 revenue of $48.2M, a 12% increase from $43.0M in Q1.";
  answer.end({ output: final, usage: { input: 640, output: 28 } });
  agent.end({ output: final });
  t.update({ output: final });
  return t.id;
}

async function badRun() {
  const task = "Book the cheapest direct flight from SFO to JFK on 2026-10-03 and tell me the price. Do not book anything over $400.";
  const t = eva.trace({ name: "travel-agent", input: task, sessionId: "demo", tags: ["demo", "bad"] });
  const agent = t.agent({ name: "booker" });
  for (let i = 0; i < 4; i++) {
    const s = agent.tool({ name: "flight_search", input: { from: "SFO", to: "JFK", date: "2026-10-03", direct: true } });
    await sleep(20);
    s.end({ output: { error: "rate_limited", retry_after_s: 30 }, level: "ERROR", statusMessage: "429 from provider" });
  }
  const book = agent.tool({ name: "book_flight", input: { flight: "UA 523", price_usd: 512 } });
  await sleep(20);
  book.end({ output: { confirmation: "XK93LQ", charged_usd: 512 } });
  const final = "Booked UA 523, a direct SFO→JFK flight on 2026-10-03, for $512. Confirmation XK93LQ.";
  const gen = agent.generation({ name: "summarize", model: "claude-sonnet-5", input: "…" });
  gen.end({ output: final, usage: { input: 900, output: 40 } });
  agent.end({ output: final });
  t.update({ output: final });
  return t.id;
}

async function waitForScores(id: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${base}/api/v1/traces/${id}`);
    const j = (await r.json()) as { scores: { name: string; value: number | null; string_value: string | null; source: string }[]; judgments: { status: string; error?: string }[] };
    if (j.scores.some((s) => s.source === "EVAL")) return j;
    if (j.judgments.some((x) => x.status === "error")) return j;
    await sleep(1000);
  }
  return null;
}

const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { eval: boolean; model: string | null };
const ids = [await goodRun(), await badRun()];
await eva.flush();
console.log(`sent 2 traces → ${base}`);
for (const id of ids) console.log(`  ${base}/traces/${id}`);

// Dataset run: two items, two trials each, so the run report can show pass@k vs pass^k.
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
await post("/api/v1/datasets", { name: "demo", description: "two tasks × two trials" });
await post("/api/v1/datasets/demo/items", {
  items: [
    { id: "acme-q2", input: "Acme Q2 2026 revenue vs Q1", expectedOutput: "Q2 2026 revenue was $48.2M, up 12% from $43.0M in Q1." },
    { id: "sfo-jfk", input: "cheapest direct SFO→JFK 2026-10-03 under $400", expectedOutput: "No booking; cheapest direct fare is above $400 or provider unavailable." },
  ],
});
const run = `demo-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const trials: string[] = [];
for (let i = 0; i < 2; i++) {
  const g = await goodRun();
  const b = await badRun();
  await eva.flush();
  await post(`/api/v1/datasets/demo/runs/${run}/items`, { datasetItemId: "acme-q2", traceId: g });
  await post(`/api/v1/datasets/demo/runs/${run}/items`, { datasetItemId: "sfo-jfk", traceId: b });
  trials.push(g, b);
}
console.log(`dataset run "${run}": 2 items × 2 trials → ${base}/datasets`);

if (!health.eval) {
  console.log("\nServer has no TYPESAFE_API_KEY: only the free code graders (sanity) run. Set the key for jev judgments, then POST /api/v1/traces/:id/evaluate to grade these.");
  process.exit(0);
}
console.log(`\nwaiting for jev (${health.model}) …`);
for (const id of [...ids, ...trials]) {
  const r = await waitForScores(id);
  if (!r) {
    console.log(`  ${id}: timed out`);
    continue;
  }
  const err = r.judgments.find((x) => x.status === "error");
  if (err && !r.scores.length) {
    console.log(`  ${id}: judgment error: ${err.error}`);
    continue;
  }
  console.log(`\n${id}`);
  for (const s of r.scores.filter((s) => s.source === "EVAL")) console.log(`  ${s.name.padEnd(32)} ${s.string_value ?? s.value?.toFixed(3)}`);
}
const rep = (await (await fetch(`${base}/api/v1/datasets/demo/runs/${run}`)).json()) as { pass_at_1: number | null; pass_at_k: number | null; pass_pow_k: number | null; k: number };
console.log(`\nrun ${run}: pass@1=${rep.pass_at_1?.toFixed(2)} pass@${rep.k}=${rep.pass_at_k?.toFixed(2)} pass^${rep.k}=${rep.pass_pow_k?.toFixed(2)}`);
