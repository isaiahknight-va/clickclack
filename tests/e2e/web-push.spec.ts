import { expect, test, type Page, type Request, type Worker } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createGeneralChannel } from "./channel-fixture";
import { waitForAppReady } from "./app-ready";

const relayOrigin = `http://127.0.0.1:${Number(process.env.CLICKCLACK_E2E_PORT || "18082") + 2}`;

// The signed-in session case carries a real session cookie, and a trace would
// keep it. Playwright sets tracing per worker, so it is off for the file.
test.use({ trace: "off" });

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
//
// The stand-in keeps the two browser rules this feature depends on: subscribe
// refuses while the registration has no active worker, the way Chromium does
// on first activation, and a subscription reports the application server key
// it was made under. A test can also start the page holding an older
// subscription, or drop the current one the way a browser rotating it would.
type StubOptions = { stale?: { endpoint: string; key: string } };

async function stubPushManager(page: Page, endpoint: string, options: StubOptions = {}) {
  await page.addInitScript(
    ({ endpoint, stale }) => {
      const subscriptionKeys = {
        // The RFC 8291 example subscription keys: a real point on P-256 and a
        // 16 byte auth secret, so the server can encrypt for them.
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      };
      const calls: string[] = [];
      let subscribed = 0;
      type StubSubscription = {
        endpoint: string;
        options: { applicationServerKey: ArrayBuffer | null };
        toJSON: () => unknown;
        unsubscribe: () => Promise<boolean>;
      };
      let current: StubSubscription | null = null;
      const makeSubscription = (subscriptionEndpoint: string, key: ArrayBuffer | null) => {
        const subscription: StubSubscription = {
          endpoint: subscriptionEndpoint,
          options: { applicationServerKey: key },
          toJSON: () => ({ endpoint: subscriptionEndpoint, keys: subscriptionKeys }),
          unsubscribe: async () => {
            calls.push(`unsubscribe:${subscriptionEndpoint}`);
            if (current === subscription) current = null;
            return true;
          },
        };
        return subscription;
      };
      if (stale) {
        const padded = stale.key.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        current = makeSubscription(stale.endpoint, bytes.buffer);
      }
      const managers = new WeakMap<ServiceWorkerRegistration, unknown>();
      const managerFor = (registration: ServiceWorkerRegistration) => {
        let manager = managers.get(registration);
        if (!manager) {
          manager = {
            subscribe: async (subscribeOptions: { applicationServerKey?: BufferSource }) => {
              if (!registration.active) {
                throw new DOMException(
                  "Subscription failed - no active Service Worker",
                  "AbortError",
                );
              }
              subscribed += 1;
              const next = subscribed === 1 ? endpoint : `${endpoint}-${subscribed}`;
              const key = subscribeOptions.applicationServerKey
                ? new Uint8Array(subscribeOptions.applicationServerKey as ArrayBuffer).slice()
                    .buffer
                : null;
              current = makeSubscription(next, key);
              calls.push(`subscribe:${next}`);
              return current;
            },
            getSubscription: async () => current,
            permissionState: async () => "granted",
          };
          managers.set(registration, manager);
        }
        return manager;
      };
      Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
        configurable: true,
        get(this: ServiceWorkerRegistration) {
          return managerFor(this);
        },
      });
      (window as unknown as { __pushStub: unknown }).__pushStub = {
        calls,
        drop: () => {
          current = null;
        },
      };
      // Chromium denies notifications to an automated profile, and the
      // permission is not what this test is about.
      class GrantedNotification {
        static permission: NotificationPermission = "granted";
        static requestPermission = () => Promise.resolve("granted" as NotificationPermission);
        close() {}
      }
      (window as unknown as { Notification: unknown }).Notification = GrantedNotification;
    },
    { endpoint, stale: options.stale },
  );
}

async function stubCalls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __pushStub: { calls: string[] } }).__pushStub.calls,
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

// rememberPushEnabled marks push as turned on for the signed-in account on
// this device, the state a returning user opens the app in. The page's own
// fetch is the one that carries the account's identity.
async function rememberPushEnabled(page: Page) {
  await page.evaluate(async () => {
    const response = await fetch("/api/me");
    const { user } = (await response.json()) as { user: { id: string } };
    window.localStorage.setItem(`clickclack:web-push-enabled:v1:${user.id}`, "enabled");
  });
}

function isPushRegistration(request: Request): boolean {
  return request.url().includes("/api/me/push/subscriptions") && request.method() === "PUT";
}

test("a device holding a subscription under an old key replaces it when the app opens", async ({
  page,
}) => {
  const endpoint = `${relayOrigin}/push/${randomUUID()}`;
  const staleEndpoint = `${relayOrigin}/push/stale-${randomUUID()}`;
  // A second real P-256 point, standing in for the key the server used before
  // its operator rotated the pair.
  const staleKey =
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  await stubPushManager(page, endpoint, { stale: { endpoint: staleEndpoint, key: staleKey } });
  const { route } = await createGeneralChannel(page, "Push rotation", true);
  await page.goto(route);
  await waitForAppReady(page);
  await rememberPushEnabled(page);

  const registered = page.waitForRequest(
    (request) =>
      isPushRegistration(request) &&
      (JSON.parse(request.postData() ?? "{}") as { endpoint?: string }).endpoint === endpoint,
  );
  await page.reload();
  await waitForAppReady(page);
  await registered;

  await expect
    .poll(() => stubCalls(page))
    .toEqual([`unsubscribe:${staleEndpoint}`, `subscribe:${endpoint}`]);
  await expect.poll(async () => (await pushState(page)).subscriptions.length).toBe(1);
});

test("a renewed subscription registers only for the account that turned push on", async ({
  page,
  context,
}) => {
  const workerRequests: string[] = [];
  context.on("request", (request) => {
    if (request.serviceWorker() && request.url().includes("/api/me/push")) {
      workerRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const endpoint = `${relayOrigin}/push/${randomUUID()}`;
  await stubPushManager(page, endpoint);
  const { route } = await createGeneralChannel(page, "Push renewal", true);
  await page.goto(route);
  await waitForAppReady(page);
  await rememberPushEnabled(page);

  // The returning user's device registers on open, which also installs the
  // worker whose renewal message this test sends.
  const firstRegistration = page.waitForRequest(isPushRegistration);
  await page.reload();
  await waitForAppReady(page);
  await firstRegistration;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

  // The browser drops the subscription and tells the worker. The worker only
  // asks the app; the app's heal registers the replacement for this user.
  await page.evaluate(() =>
    (window as unknown as { __pushStub: { drop: () => void } }).__pushStub.drop(),
  );
  const renewed = page.waitForRequest(
    (request) =>
      isPushRegistration(request) &&
      (JSON.parse(request.postData() ?? "{}") as { endpoint?: string }).endpoint ===
        `${endpoint}-2`,
  );
  await fireSubscriptionChange(worker);
  const renewal = await renewed;
  expect(renewal.serviceWorker()).toBeNull();
  expect(workerRequests).toEqual([]);
});

test("a renewal on a device where this account never turned push on registers nothing", async ({
  page,
  context,
}) => {
  const endpoint = `${relayOrigin}/push/${randomUUID()}`;
  await stubPushManager(page, endpoint);
  const { route } = await createGeneralChannel(page, "Push other account", true);
  await page.goto(route);
  await waitForAppReady(page);
  // Another account turned push on here earlier, so the worker is installed;
  // this account never did.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const registrations: string[] = [];
  context.on("request", (request) => {
    if (request.url().includes("/api/me/push")) registrations.push(request.method());
  });
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __workerMessages: string[] }).__workerMessages = seen;
    navigator.serviceWorker.addEventListener("message", (event) => {
      seen.push(String((event.data as { type?: string } | null)?.type));
    });
  });

  await fireSubscriptionChange(worker);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __workerMessages: string[] }).__workerMessages),
    )
    .toContain("clickclack:push-renew");
  // The heal returns before any request for an account without the opt-in;
  // this settle only gives a wrong implementation room to show itself.
  await page.waitForTimeout(500);
  expect(registrations).toEqual([]);
  expect(await stubCalls(page)).toEqual([]);
});

// turnPushOn flips the settings switch and waits for the device to be stored,
// then closes the dialog.
async function turnPushOn(page: Page) {
  const modal = await openNotificationSettings(page);
  const stored = page.waitForResponse(
    (response) =>
      response.url().includes("/api/me/push/subscriptions") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await modal.getByLabel("Push notifications on this device").check();
  await stored;
  await expect(modal.getByText("On for this device")).toBeVisible();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
}

// expectPushSwitch opens the settings row fresh, the way a person checks
// whether this device will ring, and asserts what the switch shows once the
// row has read the server.
async function expectPushSwitch(page: Page, checked: boolean) {
  const stateRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/me/push" && response.request().method() === "GET",
  );
  const modal = await openNotificationSettings(page);
  const control = modal.getByLabel("Push notifications on this device");
  await stateRead;
  if (checked) {
    await expect(control).toBeChecked();
  } else {
    // Off is the row's starting state, so give a wrong reading room to land
    // after the server answered before asserting it never did.
    await page.waitForTimeout(500);
    await expect(control).not.toBeChecked();
  }
  await modal.getByRole("button", { name: "Close", exact: true }).click();
}

test("a device two accounts turned push on shows it on only for the account the server delivers to", async ({
  page,
  context,
}) => {
  // One browser, one push subscription, two accounts in two tabs.
  const endpoint = `${relayOrigin}/push/${randomUUID()}`;
  await stubPushManager(page, endpoint);
  const first = await createGeneralChannel(page, "Push shared first", true);
  await page.goto(first.route);
  await waitForAppReady(page);
  await turnPushOn(page);

  const second = await context.newPage();
  await stubPushManager(second, endpoint);
  const other = await createGeneralChannel(second, "Push shared second", true);
  await second.goto(other.route);
  await waitForAppReady(second);
  await turnPushOn(second);
  // The endpoint is unique, so the second account now holds the device.
  expect((await pushState(page)).subscriptions).toHaveLength(0);
  expect((await pushState(second)).subscriptions).toHaveLength(1);

  await expectPushSwitch(page, false);
  await expectPushSwitch(second, true);

  // Opening the app as the first account re-registers the device it turned
  // on here, so the device moves back and the second account's switch reads
  // off.
  const healed = page.waitForResponse(
    (response) => isPushRegistration(response.request()) && response.status() === 200,
  );
  await page.reload();
  await waitForAppReady(page);
  await healed;
  await expectPushSwitch(second, false);
  await expectPushSwitch(page, true);
});

test("a notification tap lands at the conversation's newest message", async ({ page }) => {
  const { workspace, channel, route } = await createGeneralChannel(page, "Push tap", true);
  const elsewhere = await page.request.post(`/api/workspaces/${workspace.id}/channels`, {
    data: { name: "elsewhere", kind: "public" },
  });
  expect(elsewhere.ok()).toBe(true);
  const { channel: away } = (await elsewhere.json()) as { channel: { route_id: string } };
  await page.goto(`/app/${workspace.route_id}/${away.route_id}`);
  await waitForAppReady(page);

  const poster = await page.request.post(`/api/workspaces/${workspace.id}/bots`, {
    data: { display_name: `Tapper ${randomUUID().slice(0, 8)}` },
  });
  expect(poster.ok()).toBe(true);
  const { bot_token: botToken } = (await poster.json()) as { bot_token: { token: string } };
  let newest = "";
  for (let index = 1; index <= 60; index += 1) {
    const posted = await page.request.post(`/api/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${botToken.token}` },
      data: { body: `backlog ${index}` },
    });
    expect(posted.ok()).toBe(true);
    newest = ((await posted.json()) as { message: { id: string } }).message.id;
  }

  // The worker's notificationclick handler posts this message to the app
  // window; dispatching it on the container reaches the same listener. The
  // URL is the one the server puts in the push: storage ids, which the app
  // canonicalizes to the channel's route.
  await page.evaluate((url) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: { type: "clickclack:notification-click", url } }),
    );
  }, `/app/${workspace.id}/${channel.id}`);

  await expect(page).toHaveURL(new RegExp(`${route}$`));
  await expect(page.locator(`[data-message-id="${newest}"]`)).toBeInViewport();
});

test.describe("a device registered under a signed-in session", () => {
  const csrf = { "X-ClickClack-CSRF": "1" };

  test("stops receiving pushes when that session signs out", async ({ page }) => {
    const endpoint = `${relayOrigin}/push/${randomUUID()}`;
    await stubPushManager(page, endpoint);
    const magic = await page.request.post("/api/auth/magic/request", {
      headers: csrf,
      data: { email: `push-session-${randomUUID()}@example.com`, display_name: "Push session" },
    });
    expect(magic.status()).toBe(201);
    const login = await page.request.post("/api/auth/magic/consume", {
      headers: csrf,
      data: { token: ((await magic.json()) as { token: string }).token },
    });
    expect(login.status()).toBe(200);
    const created = await page.request.post("/api/workspaces", {
      headers: csrf,
      data: { name: `Push session ${randomUUID().slice(0, 8)}` },
    });
    expect(created.status()).toBe(201);
    const { workspace } = (await created.json()) as { workspace: { id: string; route_id: string } };
    const channelResponse = await page.request.post(`/api/workspaces/${workspace.id}/channels`, {
      headers: csrf,
      data: { name: "general", kind: "public" },
    });
    expect(channelResponse.status()).toBe(201);
    const { channel } = (await channelResponse.json()) as {
      channel: { id: string; route_id: string };
    };
    const poster = await page.request.post(`/api/workspaces/${workspace.id}/bots`, {
      headers: csrf,
      data: { display_name: `Poster ${randomUUID().slice(0, 8)}` },
    });
    expect(poster.ok()).toBe(true);
    const { bot_token: botToken } = (await poster.json()) as { bot_token: { token: string } };
    const post = async (body: string) => {
      const posted = await page.request.post(`/api/channels/${channel.id}/messages`, {
        headers: { Authorization: `Bearer ${botToken.token}` },
        data: { body },
      });
      expect(posted.ok()).toBe(true);
    };

    await page.goto(`/app/${workspace.route_id}/${channel.route_id}`);
    await waitForAppReady(page);
    await turnPushOn(page);

    // Control: the session-bound device receives while the session lives.
    const before = (await relayDeliveries(page)).length;
    await post("while signed in");
    await expect
      .poll(async () => (await relayDeliveries(page)).length, { timeout: 15_000 })
      .toBe(before + 1);

    const loggedOut = await page.request.post("/api/auth/logout", { headers: csrf, data: {} });
    expect(loggedOut.status()).toBe(200);
    await post("after signing out");
    // The control above arrives well inside this window; a push that was
    // going to leave for a signed-out session would too.
    await page.waitForTimeout(2_000);
    expect((await relayDeliveries(page)).length).toBe(before + 1);
  });
});

// fireSubscriptionChange raises the event a browser raises when it replaces a
// subscription. A synthetic event cannot extend its lifetime, so the worker's
// waitUntil throws after the handler has already started its work; that is
// the browser's rule, not the handler failing.
async function fireSubscriptionChange(worker: Worker) {
  await worker.evaluate(() => {
    const scope = self as unknown as {
      dispatchEvent: (event: Event) => boolean;
      ExtendableEvent: new (type: string) => Event;
    };
    scope.dispatchEvent(new scope.ExtendableEvent("pushsubscriptionchange"));
  });
}
