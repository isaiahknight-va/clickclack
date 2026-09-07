// Paired real-behavior proof for the unread-bar stacking fix.
// Usage (from the clickclack repo root):
//   node <this> <label> <binary> <port> <outdir>
// Starts the given binary with --dev-bootstrap, seeds a scrollable channel,
// parks mid-history, posts an unread message from a second user, opens the
// reaction picker on the row under the bar, moves the pointer off the row,
// then records which element is on top of "Mark read" and whether the click
// lands. Screenshots: proof-<label>.png (full), proof-<label>-zoom.png (bar
// region at 2x), proof-<label>-after-click.png (state after clicking).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "/Volumes/Storage/Claude Projects/COO/vendor/clickclack/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const [label, binary, portArg, outdir] = process.argv.slice(2);
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), `cc-proof-${label}-`));
mkdirSync(outdir, { recursive: true });

const server = spawn(binary, ["serve", "--addr", `127.0.0.1:${port}`, "--data", data, "--dev-bootstrap=true"], {
  stdio: "ignore",
});
const stop = () => { try { server.kill("SIGTERM"); } catch {} };
process.on("exit", stop);

for (let i = 0; i < 100; i++) {
  try { const r = await fetch(base + "/"); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const page = await context.newPage();

// dev-bootstrap: first /app visit signs in the bootstrap owner.
await page.goto(base + "/app");
await page.locator('.shell[data-app-ready="true"]').waitFor();

const ws = (await (await page.request.get(base + "/api/workspaces")).json()).workspaces[0];
const channelName = `unread-proof-${Date.now()}`;
const channel = (await (await page.request.post(`${base}/api/workspaces/${ws.id}/channels`, {
  data: { name: channelName, kind: "public" },
})).json()).channel;
for (let i = 0; i < 36; i++) {
  await page.request.post(`${base}/api/channels/${channel.id}/messages`, {
    data: { body: `**Deploy note ${i}:** 🟥🟥🟥 rolled prod-2026090${i % 10}, watch the error budget, page on-call if p95 climbs 🟥🟥🟥 ${"page on-call if p95 climbs 🟥🟥🟥 ".repeat(7)}` },
  });
}
await page.request.post(`${base}/api/channels/${channel.id}/read`, { data: { seq: 36 } });
const senderID = execFileSync(binary, [
  "admin", "user", "create", "--data", data, "--workspace", ws.id,
  "--name", "Unread Sender", "--email", `${channelName}@example.com`,
], { encoding: "utf8" }).trim();

await page.goto(base + "/app");
await page.locator('.shell[data-app-ready="true"]').waitFor();
await page.getByRole("link", { name: `# ${channelName}` }).click();
await page.locator(".markdown").filter({ hasText: "Deploy note 35" }).waitFor();
await page.waitForTimeout(600);
const scrollport = page.locator(".messages-scroll");
await scrollport.evaluate((el) => {
  el.scrollTop = Math.floor(el.scrollHeight / 2);
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
});
await page.waitForTimeout(600);

const posted = await page.request.post(`${base}/api/channels/${channel.id}/messages`, {
  headers: { "X-ClickClack-User": senderID },
  data: { body: "unread while browsing history" },
});
if (!posted.ok()) throw new Error("unread post failed");
await page.locator(".unread-bar").waitFor();
await page.waitForTimeout(400);

// Geometry, all read once, then driven by raw mouse coordinates so nothing
// scrolls the list under us.
const geo = await page.evaluate(() => {
  const bar = document.querySelector(".unread-bar").getBoundingClientRect();
  const scroll = document.querySelector(".messages-scroll").getBoundingClientRect();
  const probe = document.elementFromPoint(scroll.left + 24, bar.top + bar.height / 2);
  const row = probe?.closest(".message-row");
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return {
    rowId: row.dataset.messageId,
    row: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    bar: { left: bar.left, top: bar.top, right: bar.right, bottom: bar.bottom },
    scrollLeft: scroll.left,
  };
});
if (!geo) throw new Error("no row under the bar");
const row = page.locator(`.message-row[data-message-id="${geo.rowId}"]`);
// Hover the row in its own gutter, left of the centered bar, vertically
// inside the row's box so no neighbor takes the hover.
await page.mouse.move(geo.row.left + 30, (geo.row.top + geo.row.bottom) / 2);
await row.locator(".message-actions").evaluate((el) =>
  new Promise((resolve) => {
    const tick = () => (getComputedStyle(el).opacity === "1" ? resolve() : requestAnimationFrame(tick));
    tick();
  }),
);
const addBox = await row.getByRole("button", { name: "Add reaction" }).boundingBox();
if (!addBox) throw new Error("Add reaction not revealed");
await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
await row.locator("button.emoji-option").first().waitFor();
const heading = await page.getByRole("heading", { name: `#${channelName}` }).boundingBox();
await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
await page.waitForTimeout(300);

const rowZ = await row.evaluate((el) => getComputedStyle(el).zIndex);
const rowClasses = await row.evaluate((el) => el.className);
const barZ = await page.locator(".unread-bar").evaluate((el) => getComputedStyle(el).zIndex);
const topHit = await page.evaluate(() => {
  const t = document.querySelector(".unread-bar__mark").getBoundingClientRect();
  const top = document.elementsFromPoint(t.left + t.width / 2, t.top + t.height / 2)[0];
  return top?.closest(".unread-bar") ? "unread-bar" : `${top?.tagName}.${top?.className}`;
});
await page.screenshot({ path: join(outdir, `proof-${label}.png`) });
await page.screenshot({
  path: join(outdir, `proof-${label}-zoom.png`),
  clip: { x: geo.bar.left - 140, y: geo.bar.top - 24, width: geo.bar.right - geo.bar.left + 280, height: 96 },
});

let clickResult;
try {
  await page.getByRole("button", { name: "Mark as read" }).click({ timeout: 4000 });
  await page.locator(".unread-bar").waitFor({ state: "detached", timeout: 4000 });
  clickResult = "bar cleared";
} catch (err) {
  clickResult = `FAILED: ${String(err.message).split("\n")[0]}`;
}
await page.waitForTimeout(300);
await page.screenshot({ path: join(outdir, `proof-${label}-after-click.png`) });

console.log(`[${label}] row under the bar: ${geo.rowId} classes="${rowClasses}" z-index=${rowZ}; unread-bar z-index=${barZ}`);
console.log(`[${label}] element on top of "Mark read": ${topHit}`);
console.log(`[${label}] click "Mark read": ${clickResult}`);
console.log(`[${label}] verdict: ${topHit === "unread-bar" && clickResult === "bar cleared" ? "PASS" : "FAIL"}`);

await browser.close();
stop();
