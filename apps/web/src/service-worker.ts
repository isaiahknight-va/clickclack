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

interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
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
    listener: (event: PushSubscriptionChangeEvent) => void,
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

worker.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
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
  await worker.clients.openWindow(url);
}

// resubscribe handles the rare event where the browser replaces a subscription
// on its own. The app also re-registers on start, which is the path that
// actually heals most devices.
async function resubscribe(event: PushSubscriptionChangeEvent): Promise<void> {
  const key =
    event.oldSubscription?.options.applicationServerKey ?? (await fetchApplicationServerKey());
  if (!key) return;
  const subscription = await worker.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const payload = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  await fetch("/api/me/push/subscriptions", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-ClickClack-CSRF": "1" },
    body: JSON.stringify({
      endpoint: payload.endpoint ?? subscription.endpoint,
      keys: { p256dh: payload.keys?.p256dh ?? "", auth: payload.keys?.auth ?? "" },
      user_agent: "",
    }),
  });
}

async function fetchApplicationServerKey(): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const response = await fetch("/api/me/push", { credentials: "include" });
    if (!response.ok) return null;
    const state = (await response.json()) as { vapid_public_key?: string };
    return state.vapid_public_key ? decodeKey(state.vapid_public_key) : null;
  } catch {
    return null;
  }
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  // The buffer is allocated explicitly so the array is typed over a plain
  // ArrayBuffer, which is what pushManager.subscribe accepts.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export {};
