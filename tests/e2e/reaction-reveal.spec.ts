import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { waitForAppReady } from "./app-ready";
import { settleScrollFrames } from "./message-frames";

// Adding a reaction to the last message grows its row. If the list is not
// following the bottom, the new chip must still be scrolled into view.
test("a reaction added to the last message stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().slice(0, 8);
  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: `Reveal ${suffix}` },
  });
  const { workspace } = (await workspaceResponse.json()) as {
    workspace: { id: string; route_id: string };
  };
  const channelResponse = await page.request.post(`/api/workspaces/${workspace.id}/channels`, {
    data: { name: `reveal-${suffix}`, kind: "public" },
  });
  const { channel } = (await channelResponse.json()) as {
    channel: { id: string; route_id: string };
  };
  let lastID = "";
  for (let i = 0; i < 14; i++) {
    const response = await page.request.post(`/api/channels/${channel.id}/messages`, {
      data: { body: `Message ${i}: the quick brown fox jumps over the lazy dog and keeps going.` },
    });
    lastID = ((await response.json()) as { message: { id: string } }).message.id;
  }
  await page.goto(`/app/${workspace.route_id}/${channel.route_id}`);
  await waitForAppReady(page);
  await expect(page.locator(".messages.is-revealing")).toHaveCount(0);
  await settleScrollFrames(page);

  const scroller = page.locator(".messages-scroll");
  // Pin to the bottom, then leave the list a little short of it, the way a
  // trackpad or a finger usually does.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settleScrollFrames(page);
  await scroller.evaluate((el) => {
    el.scrollTop -= 24;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settleScrollFrames(page);

  const row = page.locator(`[data-message-id="${lastID}"]`).first();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + box.height / 2);
  await row.getByRole("button", { name: "React with 👍" }).click();
  const chip = row.locator(".reactions-bar button").first();
  await expect(chip).toBeVisible();
  await settleScrollFrames(page);

  if (process.env.PROOF_OUT) {
    await page.screenshot({
      path: `${process.env.PROOF_OUT}/${process.env.PROOF_TAG}-reveal.png`,
      clip: { x: 0, y: 560, width: 390, height: 284 },
    });
  }
  const placement = await page.evaluate((id) => {
    const scroll = document.querySelector(".messages-scroll")!.getBoundingClientRect();
    const bar = document
      .querySelector(`[data-message-id="${id}"] .reactions-bar`)!
      .getBoundingClientRect();
    return { chipBottom: bar.bottom, scrollBottom: scroll.bottom };
  }, lastID);
  expect(placement.chipBottom).toBeLessThanOrEqual(placement.scrollBottom);
});
