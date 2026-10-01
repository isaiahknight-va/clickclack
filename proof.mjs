// Headless frame proof for the PR "fix(web): idle conversations redraw on every display refresh".
// Run from a ClickClack checkout (after pnpm install) so @playwright/test resolves.
// usage: node proof.mjs <label> <baseURL> <outDir>
// Drives headless Chromium (Playwright's headless shell, 60 Hz synthetic BeginFrames)
// against a throwaway dev-bootstrap server and, per scenario, lists the running
// animations and traces 10 s of an untouched page, counting compositor frames.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const [label, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACE_MS = 10_000;
const CATS = [
  "toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame", "blink", "cc", "viz", "gpu", "benchmark",
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const api = async (method, path, data, token) => {
  const res = await page.request.fetch(path, { method, data, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${await res.text()}`);
  return res.json();
};

const suffix = Math.random().toString(36).slice(2, 10);
const { workspace } = await api("POST", "/api/workspaces", { name: `Proof ${suffix}` });
const { channel } = await api("POST", `/api/workspaces/${workspace.id}/channels`, { name: `proof-${suffix}`, kind: "public" });
const { channel: busy } = await api("POST", `/api/workspaces/${workspace.id}/channels`, { name: `busy-${suffix}`, kind: "public" });
const { bot, bot_token } = await api("POST", `/api/workspaces/${workspace.id}/bots`, { display_name: "Blackbird", handle: `blackbird-${suffix}`, token_name: "proof", scopes: ["bot:write"] });
const { conversation: dm } = await api("POST", "/api/dms", { workspace_id: workspace.id, member_ids: [bot.id] });
for (const body of ["Morning check is done.", "Nothing new on the board.", "Settled channel"]) await api("POST", `/api/channels/${channel.id}/messages`, { body });
for (const body of ["Ping me when the build is green.", "Settled DM"]) await api("POST", `/api/dms/${dm.id}/messages`, { body });
const { message: root } = await api("POST", `/api/channels/${channel.id}/messages`, { body: "Thread root for the embed" });
await api("POST", `/api/messages/${root.id}/thread/replies`, { body: "Settled reply" });
const { root: threadRoot } = await api("GET", `/api/messages/${root.id}/thread`);
for (let i = 0; i < 40; i++) await api("POST", `/api/channels/${busy.id}/messages`, { body: `read history ${i} ${"enough text to scroll ".repeat(4)}` });

const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => {
  const effect = a.effect instanceof KeyframeEffect ? a.effect : null;
  const t = effect?.target;
  const host = t?.classList.length ? t : t?.parentElement;
  const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : a.id;
  return `${name} on .${host?.classList[0]}${effect?.pseudoElement ?? ""}`;
}));

function countFrames(events) {
  const proc = {}, thread = {};
  for (const e of events) {
    if (e.ph === "M" && e.name === "process_name") proc[e.pid] = e.args?.name;
    if (e.ph === "M" && e.name === "thread_name") thread[`${e.pid}:${e.tid}`] = e.args?.name;
  }
  const want = {
    beginFrame: (p, t, n) => p === "Renderer" && t === "Compositor" && n === "BeginFrame",
    drawnFrames: (p, t, n) => p === "Renderer" && t === "Compositor" && n === "ProxyImpl::ScheduledActionDraw",
    mainThreadFrames: (p, t, n) => p === "Renderer" && t === "CrRendererMain" && n === "ProxyMain::BeginMainFrame",
    mainThreadPaints: (p, t, n) => p === "Renderer" && t === "CrRendererMain" && n === "Paint",
    gpuSwaps: (p, t, n) => p === "GPU Process" && n === "Display::DrawAndSwap",
  };
  const out = Object.fromEntries(Object.keys(want).map((k) => [k, 0]));
  let min = Infinity, max = -Infinity;
  for (const e of events) {
    if (typeof e.ts === "number" && e.ts > 0) { min = Math.min(min, e.ts); max = Math.max(max, e.ts); }
    if (!["X", "B", "I", "i", "n"].includes(e.ph)) continue;
    const p = proc[e.pid], t = thread[`${e.pid}:${e.tid}`];
    for (const [k, f] of Object.entries(want)) if (f(p, t, e.name)) out[k] += 1;
  }
  out.spanMs = Math.round((max - min) / 1000);
  return out;
}

async function measure(name) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const animations = await running();
  await browser.startTracing(page, { categories: CATS });
  await sleep(TRACE_MS);
  const buf = await browser.stopTracing();
  const events = JSON.parse(buf.toString()).traceEvents;
  writeFileSync(`${outDir}/${label}-${name}-trace.json.gz`, gzipSync(buf));
  const frames = countFrames(events);
  const after = await running();
  const rec = { build: label, scenario: name, runningAtStart: animations, runningAtEnd: after, frames };
  console.log(JSON.stringify(rec));
  return rec;
}

const ready = async (text) => {
  await page.locator('.shell[data-app-ready="true"]').waitFor();
  await page.locator(".markdown", { hasText: text }).first().waitFor();
};
const results = [];

await page.goto(`/app/${workspace.route_id}/${channel.route_id}`);
await ready("Settled channel");
await sleep(3000);
results.push(await measure("idle-channel"));

await page.goto(`/app/${workspace.route_id}/${dm.route_id}`);
await ready("Settled DM");
await sleep(3000);
results.push(await measure("idle-dm"));

await page.goto(`/app/${workspace.route_id}/${busy.route_id}`);
await ready("read history 39");
await sleep(1000);
await page.locator(".messages-scroll").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
await sleep(1000);
await api("POST", `/api/channels/${busy.id}/messages`, { body: "unread while scrolled up" }, bot_token.token);
await page.locator(".unread-bar__jump").waitFor();
await sleep(6000);
results.push(await measure("unread-bar-open"));

await page.goto(`/embed/channel/${workspace.route_id}/${channel.route_id}`);
await page.locator(".markdown", { hasText: "Settled channel" }).first().waitFor();
await sleep(3000);
results.push(await measure("embed-channel"));

await page.goto(`/embed/thread/${workspace.route_id}/${threadRoot.route_id}`);
await page.locator(".markdown", { hasText: "Settled reply" }).first().waitFor();
await sleep(3000);
results.push(await measure("embed-thread"));

writeFileSync(`${outDir}/${label}.json`, JSON.stringify({ label, base, ua: await page.evaluate(() => navigator.userAgent), traceMs: TRACE_MS, results }, null, 1));
await browser.close();
