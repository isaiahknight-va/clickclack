// ClickClack's service worker exists for one job: showing a notification the
// server pushed, and opening the right conversation when it is tapped.
//
// It installs no fetch handler and caches nothing, so a release behaves
// exactly as it does without a worker. The app registers it only after
// someone turns push on, never on load and never from an embed.
//
// The worker types live here rather than behind a webworker library
// reference: the app typechecks as one program, and pulling that library in
// beside the DOM one redeclares hundreds of shared names.

import { pushLandingURL } from "./lib/push-landing";

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface PushMessageData {
  json(): unknown;
}

interface PushEvent extends ExtendableEvent {
  readonly data: PushMessageData | null;
}

interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
}

interface WindowClient {
  readonly url: string;
  focus(): Promise<WindowClient>;
  postMessage(message: unknown): void;
}

interface WorkerClients {
  claim(): Promise<void>;
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClient[]>;
  openWindow(url: string): Promise<WindowClient | null>;
}

interface WorkerScope {
  readonly clients: WorkerClients;
  readonly registration: ServiceWorkerRegistration;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
  addEventListener(
    type: "pushsubscriptionchange",
    listener: (event: ExtendableEvent) => void,
  ): void;
}

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
};

const worker = self as unknown as WorkerScope;

const FALLBACK_TITLE = "ClickClack";
const FALLBACK_BODY = "New message";
const FALLBACK_URL = "/app";

worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener("push", (event) => {
  // Safari revokes push permission from an app that receives a push without
  // showing something, so every push shows a notification even when the
  // payload is missing or unreadable.
  const payload = readPayload(event.data);
  const url = payload.url?.startsWith("/") ? payload.url : FALLBACK_URL;
  event.waitUntil(
    worker.registration.showNotification(payload.title || FALLBACK_TITLE, {
      body: payload.body || FALLBACK_BODY,
      // The tag matches the one the in-page notification uses, so a device
      // showing both collapses them into a single alert.
      tag: payload.tag || "clickclack",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  event.waitUntil(openApp(typeof data?.url === "string" ? data.url : FALLBACK_URL));
});

// The browser replaced or dropped this device's subscription on its own. The
// worker never registers the replacement: it cannot know which account on this
// device turned push on, and the cookies it would send belong to whoever is
// signed in now, who may never have opted in. It asks an open app window to
// run the account-scoped heal instead, which registers only for a user who
// turned push on here. The cost is deliberate: a device whose subscription
// rotates while the app is closed re-registers the next time the app opens,
// and receives nothing until then.
worker.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(askAppToRenew());
});

function readPayload(data: PushMessageData | null): PushPayload {
  if (!data) return {};
  try {
    const parsed = data.json();
    return parsed && typeof parsed === "object" ? (parsed as PushPayload) : {};
  } catch {
    return {};
  }
}

async function openApp(url: string): Promise<void> {
  const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Only the app itself is a navigation target. An embedded channel lives
  // inside someone else's page and must never be steered.
  const appClient = clients.find((client) => new URL(client.url).pathname.startsWith("/app"));
  if (appClient) {
    appClient.postMessage({ type: "clickclack:notification-click", url });
    await appClient.focus();
    return;
  }
  // A fresh window may not be listening yet when a message would arrive, so
  // the tap travels in the URL instead.
  await worker.clients.openWindow(pushLandingURL(url));
}

async function askAppToRenew(): Promise<void> {
  const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    // Embedded channels live inside someone else's page; only the app heals.
    if (new URL(client.url).pathname.startsWith("/app")) {
      client.postMessage({ type: "clickclack:push-renew" });
    }
  }
}
