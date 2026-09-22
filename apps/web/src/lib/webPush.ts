// Web push, the third notification leg beside the in-page alerts and Pushover.
// The server holds the subscription; this module only talks to the browser and
// keeps a per-user note of which devices the user turned on.

import { api } from "./api";
import { applicationServerKey, deviceLabel, pushSupported } from "./push-capability";

export type PushDevice = {
  id: string;
  user_agent: string;
  created_at: string;
  updated_at: string;
  last_success_at?: string;
  failure_count: number;
};

export type PushState = {
  enabled: boolean;
  vapid_public_key: string;
  subscriptions: PushDevice[];
};

const STORAGE_PREFIX = "clickclack:web-push-enabled:v1:";
const WORKER_URL = "/service-worker.js";

function storageKey(userID: string): string {
  return `${STORAGE_PREFIX}${userID}`;
}

export function readPushEnabled(userID: string): boolean {
  if (!userID) return false;
  try {
    return window.localStorage.getItem(storageKey(userID)) === "enabled";
  } catch {
    return false;
  }
}

export function writePushEnabled(userID: string, enabled: boolean): void {
  if (!userID) return;
  try {
    if (enabled) window.localStorage.setItem(storageKey(userID), "enabled");
    else window.localStorage.removeItem(storageKey(userID));
  } catch {
    // A blocked storage jar only costs the reminder to re-register on start.
  }
}

export function fetchPushState(): Promise<PushState> {
  return api<PushState>("/api/me/push");
}

// registerPushWorker installs the worker only when a user asks for push. The
// app never registers it on load, and it is never registered from an embed.
export async function registerPushWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  return navigator.serviceWorker.register(WORKER_URL, { scope: "/" });
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? await registration.pushManager.getSubscription() : null;
}

export async function storeSubscription(subscription: PushSubscription): Promise<PushDevice> {
  const payload = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  const result = await api<{ subscription: PushDevice }>("/api/me/push/subscriptions", {
    method: "PUT",
    body: JSON.stringify({
      endpoint: payload.endpoint ?? subscription.endpoint,
      keys: { p256dh: payload.keys?.p256dh ?? "", auth: payload.keys?.auth ?? "" },
      user_agent: deviceLabel(),
    }),
  });
  return result.subscription;
}

export async function forgetSubscription(endpoint: string): Promise<void> {
  await api<void>("/api/me/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
}

// healPushSubscription re-registers this device on app start when the user
// left push on here. Reinstalls and key rotations both change the endpoint, so
// without this a device goes quiet with nothing on screen to explain it.
export async function healPushSubscription(userID: string): Promise<void> {
  if (!userID || !pushSupported() || !readPushEnabled(userID)) return;
  try {
    const state = await fetchPushState();
    if (!state.enabled) return;
    const registration = await registerPushWorker();
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(state.vapid_public_key),
      }));
    await storeSubscription(subscription);
  } catch {
    // The settings row is the recovery path; a failed heal must never break
    // the app's boot.
  }
}
