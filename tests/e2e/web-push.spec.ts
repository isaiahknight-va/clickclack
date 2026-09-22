import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createGeneralChannel } from "./channel-fixture";
import { waitForAppReady } from "./app-ready";

const relayOrigin = `http://127.0.0.1:${Number(process.env.CLICKCLACK_E2E_PORT || "18082") + 2}`;

type Delivery = {
  hasVapidToken: boolean;
  contentEncoding?: string;
  contentType?: string;
  ttl?: string;
  urgency?: string;
  encryptedBytes: number;
};

// The browser will not hand out a real push subscription in a headless run, so
// the push manager is replaced with one that points at the fake relay. The
// service worker, the settings row, the API, and the server's encryption and
// delivery are all the real ones.
async function stubPushManager(page: Page, endpoint: string) {
  await page.addInitScript(
    ({ endpoint }) => {
      const subscriptionKeys = {
        // The RFC 8291 example subscription keys: a real point on P-256 and a
        // 16 byte auth secret, so the server can encrypt for them.
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      };
      let current: unknown = null;
      const subscription = {
        endpoint,
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: subscriptionKeys }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      const pushManager = {
        subscribe: async () => {
          current = subscription;
          return subscription;
        },
        getSubscription: async () => current,
        permissionState: async () => "granted",
      };
      Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
        configurable: true,
        get: () => pushManager,
      });
      // Chromium denies notifications to an automated profile, and the
      // permission is not what this test is about.
      class GrantedNotification {
        static permission: NotificationPermission = "granted";
        static requestPermission = () => Promise.resolve("granted" as NotificationPermission);
        close() {}
      }
      (window as unknown as { Notification: unknown }).Notification = GrantedNotification;
    },
    { endpoint },
  );
}

async function openNotificationSettings(page: Page) {
  // At phone width the rail with the account button lives behind the nav
  // toggle, exactly as a person on a phone finds it.
  const navToggle = page.locator(".mobile-nav-toggle");
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: /Account settings for/ }).click();
  const modal = page.getByRole("dialog", { name: "Account settings" });
  await expect(modal.getByRole("heading", { name: "Profile settings" })).toBeVisible();
  await modal.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(modal.getByRole("heading", { name: "Notifications" })).toBeVisible();
  return modal;
}

// The page's own fetch carries the signed-in identity that page.request does
// not, so every assertion about this account reads through the app.
async function pushState(page: Page): Promise<{
  enabled: boolean;
  vapid_public_key: string;
  subscriptions: { id: string; user_agent: string }[];
}> {
  return page.evaluate(() => fetch("/api/me/push").then((response) => response.json()));
}

async function relayDeliveries(page: Page): Promise<Delivery[]> {
  const response = await page.request.get(`${relayOrigin}/deliveries`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Delivery[];
}

for (const surface of ["desktop", "phone"] as const) {
  test(`a ${surface} device turns push on and receives a delivery`, async ({ page }, testInfo) => {
    if (surface === "phone") await page.setViewportSize({ width: 390, height: 844 });
    const endpoint = `${relayOrigin}/push/${randomUUID()}`;
    await stubPushManager(page, endpoint);

    // An isolated account keeps this test's devices out of every other
    // test's subscription list.
    const { workspace, channel, route } = await createGeneralChannel(page, `Push ${surface}`, true);
    await page.goto(route);
    await waitForAppReady(page);

    const before = (await relayDeliveries(page)).length;
    const modal = await openNotificationSettings(page);
    const control = modal.getByLabel("Push notifications on this device");
    await expect(control).toBeEnabled();

    const stored = page.waitForResponse(
      (response) =>
        response.url().includes("/api/me/push/subscriptions") &&
        response.request().method() === "PUT" &&
        response.status() === 200,
    );
    await control.check();
    await stored;
    await expect(modal.getByText("On for this device")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`push-on-${surface}.png`) });

    const body = await pushState(page);
    expect(body.enabled).toBe(true);
    expect(body.vapid_public_key).not.toBe("");
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].user_agent).not.toBe("");
    // The summary is the whole story the API tells about a device.
    expect(JSON.stringify(body.subscriptions[0])).not.toContain(endpoint);

    await modal.getByRole("button", { name: "Close", exact: true }).click();

    // A second member posts, because the author never notifies themselves.
    const poster = await page.request.post(`/api/workspaces/${workspace.id}/bots`, {
      data: { display_name: `Poster ${randomUUID().slice(0, 8)}` },
    });
    expect(poster.ok()).toBe(true);
    const { bot, bot_token: botToken } = (await poster.json()) as {
      bot: { id: string };
      bot_token: { token: string };
    };
    const posted = await page.request.post(`/api/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${botToken.token}` },
      data: { body: `hello from ${bot.id}` },
    });
    expect(posted.ok()).toBe(true);

    await expect
      .poll(async () => (await relayDeliveries(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(before);
    const delivery = (await relayDeliveries(page)).at(-1)!;
    expect(delivery.hasVapidToken).toBe(true);
    expect(delivery.contentEncoding).toBe("aes128gcm");
    expect(delivery.contentType).toBe("application/octet-stream");
    expect(delivery.ttl).toBe("86400");
    expect(delivery.urgency).toBe("normal");
    // Salt, the payload, the sender key, and the tag: an empty body would be
    // far smaller than this.
    expect(delivery.encryptedBytes).toBeGreaterThan(100);

    const reopened = await openNotificationSettings(page);
    const control2 = reopened.getByLabel("Push notifications on this device");
    await expect(control2).toBeChecked();
    await control2.uncheck();
    await expect(reopened.getByText("Off for this device")).toBeVisible();
    expect((await pushState(page)).subscriptions).toHaveLength(0);
  });
}
