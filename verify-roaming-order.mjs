// Paired real-behavior proof for roaming channel order.
// Usage (from the clickclack repo root): node <this> <label> <binary> <port> <outdir>
// Context A reorders a channel to the top with the real drag control. Context B is a
// brand-new browser context (empty localStorage, same account via dev-bootstrap) that
// loads the app once. Parent: B shows the server default order. Head: B shows A's order.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "/Volumes/Storage/Claude Projects/COO/vendor/clickclack/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs";

const [label, binary, portArg, outdir] = process.argv.slice(2);
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), `cc-chorder-${label}-`));
mkdirSync(outdir, { recursive: true });
const server = spawn(binary, ["serve", "--addr", `127.0.0.1:${port}`, "--data", data, "--dev-bootstrap=true"], { stdio: "ignore" });
const stop = () => { try { server.kill("SIGTERM"); } catch {} };
process.on("exit", stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const browser = await chromium.launch();
const A = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const a = await A.newPage();
await a.goto(base + "/app");
await a.locator('.shell[data-app-ready="true"]').waitFor();
const suffix = Date.now().toString(36);
const ws = (await (await a.request.post(base + "/api/workspaces", { data: { name: `Roam ${suffix}` } })).json()).workspace;
const names = [`aa-${suffix}`, `mm-${suffix}`, `zz-${suffix}`];
for (const name of names) await a.request.post(`${base}/api/workspaces/${ws.id}/channels`, { data: { name } });
await a.goto(`${base}/app/${ws.route_id}`);
await a.locator('.shell[data-app-ready="true"]').waitFor();
const channelNames = (p) => p.locator("#sidebar-channels-list a.channel .nav-label").evaluateAll((ls) => ls.map((l) => (l.textContent || "").trim()));
await a.waitForFunction(() => document.querySelectorAll("#sidebar-channels-list a.channel").length >= 3);
const before = await channelNames(a);
// Drag zz to the top (the same gesture the upstream e2e uses).
const source = a.getByRole("button", { name: `Move #${names[2]}` });
const target = a.getByRole("link", { name: `# ${names[0]}` }).locator("..");
await source.dragTo(target, { targetPosition: { x: 40, y: 1 } });
await a.waitForTimeout(1500); // past the 400 ms account write debounce
const afterA = await channelNames(a);
await a.screenshot({ path: join(outdir, `roam-${label}-context-a.png`) });

const B = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const b = await B.newPage();
await b.goto(`${base}/app/${ws.route_id}`);
await b.locator('.shell[data-app-ready="true"]').waitFor();
await b.waitForFunction(() => document.querySelectorAll("#sidebar-channels-list a.channel").length >= 3);
await b.waitForTimeout(500);
const afterB = await channelNames(b);
await b.screenshot({ path: join(outdir, `roam-${label}-context-b.png`) });
const me = await (await b.request.get(base + "/api/me")).json();
const account = me.user?.sidebar_preferences?.channel_order?.[ws.id] ?? null;

console.log(`[${label}] context A before drag: ${before.join(", ")}`);
console.log(`[${label}] context A after drag:  ${afterA.join(", ")}`);
console.log(`[${label}] context B (fresh):     ${afterB.join(", ")}`);
console.log(`[${label}] /api/me sidebar_preferences.channel_order for this workspace: ${account ? account.length + " ids" : "absent"}`);
console.log(`[${label}] verdict: ${JSON.stringify(afterB) === JSON.stringify(afterA) && afterA[0] === names[2] ? "PASS (order roamed)" : "FAIL (second context shows " + (afterB[0] === names[0] ? "the default order" : "an unexpected order") + ")"}`);
await browser.close(); stop();
