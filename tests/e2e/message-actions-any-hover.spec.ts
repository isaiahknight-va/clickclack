import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { waitForAppReady } from "./app-ready";
import { settleScrollFrames } from "./message-frames";
// A tablet with a trackpad: the primary pointer is coarse and cannot hover, but a
// fine, hovering pointer is attached (any-hover: hover, any-pointer: fine). This
// is what iPadOS reports with a trackpad or mouse connected.
test.use({
  hasTouch: false,
  launchOptions: {
    args: [
      "--blink-settings=primaryPointerType=2,availablePointerTypes=6,primaryHoverType=1,availableHoverTypes=3",
    ],
  },
});
test("trackpad on a touch-first device can open message actions", async ({ page }) => {
  const x = randomUUID().slice(0, 8);
  const ws = (await (
    await page.request.post("/api/workspaces", { data: { name: `Pad ${x}` } })
  ).json()) as any;
  const ch = (await (
    await page.request.post(`/api/workspaces/${ws.workspace.id}/channels`, {
      data: { name: `pad-${x}`, kind: "public" },
    })
  ).json()) as any;
  const bot = (await (
    await page.request.post(`/api/workspaces/${ws.workspace.id}/bots`, {
      data: {
        display_name: "Blackbird",
        handle: `blackbird-${x}`,
        token_name: "e2e",
        scopes: ["bot:write"],
      },
    })
  ).json()) as any;
  for (let i = 0; i < 8; i++) {
    await page.request.post(`/api/channels/${ch.channel.id}/messages`, {
      data: { body: `Earlier message ${i}` },
    });
  }
  const posted = await page.request.post(`/api/channels/${ch.channel.id}/messages`, {
    headers: { Authorization: `Bearer ${bot.bot_token.token}` },
    data: { body: `Trophy line ${x}` },
  });
  const msg = ((await posted.json()) as any).message;
  await page.goto(`/app/${ws.workspace.route_id}/${ch.channel.route_id}`);
  await waitForAppReady(page);
  await expect(page.locator(".messages.is-revealing")).toHaveCount(0);
  await settleScrollFrames(page);
  const mq = await page.evaluate(() => ({
    hover: matchMedia("(hover: hover)").matches,
    anyHover: matchMedia("(any-hover: hover)").matches,
    coarse: matchMedia("(pointer: coarse)").matches,
    anyFine: matchMedia("(any-pointer: fine)").matches,
  }));
  console.log("MQ", JSON.stringify(mq));
  expect(mq).toEqual({ hover: false, anyHover: true, coarse: true, anyFine: true });
  const row = page.locator(`[data-message-id="${msg.id}"]`).first();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + box.height / 2);
  const add = row.getByRole("button", { name: "Add reaction" });
  if (process.env.PROOF_OUT)
    await page.screenshot({
      path: `${process.env.PROOF_OUT}/${process.env.PROOF_TAG}-hover.png`,
      clip: { x: 0, y: Math.max(0, box.y - 70), width: 1280, height: 150 },
    });
  await expect(add).toBeVisible();
  const size = await add.boundingBox();
  expect(size!.width).toBeGreaterThan(12);
  await add.click();
  await row.locator("button.emoji-option").first().click();
  await expect(row.locator(".reactions-bar button").first()).toBeVisible();
});
