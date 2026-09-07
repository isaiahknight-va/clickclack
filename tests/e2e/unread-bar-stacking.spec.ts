import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { settleScrollFrames } from "./message-frames";

// The unread bar floats over the scrollport at z-index 5. A row with an open
// ⋮ menu or reaction picker lifts to z-index 6, so without a stacking context
// on the scrollport the row paints over the bar and swallows "Mark read".
test("unread bar stays above a row with an open reaction picker", async ({ page }) => {
  const workspacesResponse = await page.request.get("/api/workspaces");
  const workspaces = (await workspacesResponse.json()) as { workspaces: { id: string }[] };
  const workspaceId = workspaces.workspaces[0].id;
  const channelName = `unread-stack-${Date.now()}`;
  const channelResponse = await page.request.post(`/api/workspaces/${workspaceId}/channels`, {
    data: { name: channelName, kind: "public" },
  });
  const channel = (await channelResponse.json()) as { channel: { id: string; name: string } };

  for (let i = 0; i < 36; i++) {
    const response = await page.request.post(`/api/channels/${channel.channel.id}/messages`, {
      data: {
        body: `read history ${i} ${"with enough text to create scrollable history ".repeat(3)}`,
      },
    });
    expect(response.ok()).toBe(true);
  }
  const historyReadResponse = await page.request.post(`/api/channels/${channel.channel.id}/read`, {
    data: { seq: 36 },
  });
  expect(historyReadResponse.ok()).toBe(true);

  const senderID = execFileSync(
    "go",
    [
      "run",
      "./apps/api/cmd/clickclack",
      "admin",
      "user",
      "create",
      "--data",
      "./data/e2e",
      "--workspace",
      workspaceId,
      "--name",
      "Unread Sender",
      "--email",
      `${channelName}@example.com`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();

  await page.goto("/app");
  await page.getByRole("link", { name: `# ${channel.channel.name}` }).click();
  await expect(page.getByRole("heading", { name: `#${channel.channel.name}` })).toBeVisible();
  await expect(page.locator(".markdown").filter({ hasText: "read history 35" })).toBeVisible();
  await settleScrollFrames(page);

  const scrollport = page.locator(".messages-scroll");
  await expect
    .poll(() => scrollport.evaluate((el) => el.scrollHeight > el.clientHeight + 120))
    .toBe(true);
  // Park mid-history so a message row sits under the bar's slot.
  await scrollport.evaluate((el) => {
    el.scrollTop = Math.floor(el.scrollHeight / 2);
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settleScrollFrames(page);

  const unreadResponse = await page.request.post(`/api/channels/${channel.channel.id}/messages`, {
    headers: { "X-ClickClack-User": senderID },
    data: { body: "unread while browsing history" },
  });
  expect(unreadResponse.ok()).toBe(true);

  const bar = page.locator(".unread-bar");
  await expect(bar).toBeVisible();
  const markRead = page.getByRole("button", { name: "Mark as read" });
  await expect(markRead).toBeVisible();

  // The row rendered under the bar is the one whose picker will lift it.
  const rowId = await page.evaluate(() => {
    const bar = document.querySelector(".unread-bar")!.getBoundingClientRect();
    const scroll = document.querySelector(".messages-scroll")!.getBoundingClientRect();
    const y = bar.top + bar.height / 2;
    const probe = document.elementFromPoint(scroll.left + 24, y);
    return probe?.closest<HTMLElement>(".message-row")?.dataset.messageId ?? null;
  });
  expect(rowId).not.toBeNull();
  const row = page.locator(`.message-row[data-message-id="${rowId}"]`);
  await row.hover({ position: { x: 12, y: 8 } });
  await row.getByRole("button", { name: "Add reaction" }).click();
  await expect(row.locator("button.emoji-option").first()).toBeVisible();
  // Leave the row: the :hover lift (5) outranks menu-open (6) in cascade
  // order, so the picker's lift only takes effect once the pointer is off
  // the row, which is exactly the state a user is in while reaching for
  // "Mark read".
  const heading = await page
    .getByRole("heading", { name: `#${channel.channel.name}` })
    .boundingBox();
  if (!heading) throw new Error("missing channel heading box");
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  // Precondition: the open picker lifts its row above the bar's own z-index.
  await expect
    .poll(() => row.evaluate((el) => Number(getComputedStyle(el).zIndex)))
    .toBeGreaterThan(5);

  const topHit = await page.evaluate(() => {
    const target = document.querySelector(".unread-bar__mark")!.getBoundingClientRect();
    const top = document.elementsFromPoint(
      target.left + target.width / 2,
      target.top + target.height / 2,
    )[0];
    return top?.closest(".unread-bar") ? "unread-bar" : `${top?.tagName}.${top?.className}`;
  });
  expect(topHit).toBe("unread-bar");

  await markRead.click({ timeout: 5_000 });
  await expect(bar).toHaveCount(0);
});
