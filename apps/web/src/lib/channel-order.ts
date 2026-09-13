// Personal sidebar channel order.
//
// The order roams with the account. localStorage remains the pre-paint cache
// and the offline fallback, so a reorder takes effect before any request goes
// out and survives a server that cannot be reached. On load the account's saved
// order wins over the cache and is written back into it; a workspace this
// session has already reordered keeps its local order until the next load.
//
// The account write is injected rather than imported so this module depends on
// nothing but types. Callers pass the API helper.

import type { User } from "./types";

export type ChannelOrderRequest = (path: string, init: RequestInit) => Promise<unknown>;

export type ChannelOrderPatchBody = {
  sidebar_preferences: { channel_order: Record<string, readonly string[]> };
};

export const CHANNEL_ORDER_STORAGE_PREFIX = "clickclack:sidebar-channel-order:v1:";
export const MAX_CHANNEL_ORDER_STORAGE_LENGTH = 1_000_000;
export const MAX_CHANNEL_ORDER_IDS = 10_000;
export const MAX_CHANNEL_ID_LENGTH = 128;

// The account copy is bounded by the protocol. A longer local order still
// applies on this device; the leading window is what roams.
export const MAX_ROAMING_CHANNEL_ORDER_IDS = 500;

export const CHANNEL_ORDER_PATCH_DEBOUNCE_MS = 400;

type PendingChannelOrderPatch = {
  timer: ReturnType<typeof setTimeout>;
  body: ChannelOrderPatchBody;
};

const pendingPatches = new Map<string, PendingChannelOrderPatch>();
const reorderedThisSession = new Set<string>();

function cacheScope(workspaceID: string, userID: string): string {
  return `${userID}:${workspaceID}`;
}

export function channelOrderStorageKey(workspaceID: string, userID: string): string {
  return `${CHANNEL_ORDER_STORAGE_PREFIX}${userID}:${workspaceID}`;
}

export function parseChannelOrder(raw: string | null): string[] {
  if (!raw || raw.length > MAX_CHANNEL_ORDER_STORAGE_LENGTH) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.length <= MAX_CHANNEL_ORDER_IDS &&
      parsed.every((id) => typeof id === "string" && id.length <= MAX_CHANNEL_ID_LENGTH)
      ? [...new Set(parsed)]
      : [];
  } catch {
    return [];
  }
}

export function loadChannelOrder(workspaceID: string, userID: string): string[] {
  if (!workspaceID || !userID) return [];
  try {
    return parseChannelOrder(
      window.localStorage.getItem(channelOrderStorageKey(workspaceID, userID)),
    );
  } catch {
    return [];
  }
}

function writeChannelOrderCache(workspaceID: string, userID: string, order: string[]) {
  if (!workspaceID || !userID) return;
  try {
    const key = channelOrderStorageKey(workspaceID, userID);
    if (order.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const serialized = JSON.stringify(order);
    if (serialized.length > MAX_CHANNEL_ORDER_STORAGE_LENGTH) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, serialized);
  } catch {
    // Storage is an enhancement; reordering still works for this session.
  }
}

// sanitizeServerChannelOrder applies the same shape rules to the account copy
// that the cache gets, so a hand-written API value cannot widen what the
// sidebar trusts.
function sanitizeServerChannelOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || !id || id.length > MAX_CHANNEL_ID_LENGTH) continue;
    if (seen.size >= MAX_CHANNEL_ORDER_IDS) break;
    seen.add(id);
  }
  return [...seen];
}

// mergeChannelOrder resolves one workspace. An account order, including a
// cleared one, replaces the cache. No account order at all leaves the cache
// alone, which is what an older server and an offline first paint both look
// like.
export function mergeChannelOrder(
  serverOrder: readonly string[] | undefined,
  localOrder: readonly string[],
): string[] {
  if (serverOrder === undefined) return [...localOrder];
  return sanitizeServerChannelOrder(serverOrder);
}

export function serverChannelOrder(
  user: User | null,
  workspaceID: string,
): readonly string[] | undefined {
  if (!workspaceID) return undefined;
  const order = user?.sidebar_preferences?.channel_order?.[workspaceID];
  return Array.isArray(order) ? order : undefined;
}

// resolveChannelOrder produces the order to render and refreshes the cache from
// the account. A workspace already reordered in this session keeps its local
// order, so an account snapshot loaded before that reorder cannot undo it.
export function resolveChannelOrder(user: User | null, workspaceID: string): string[] {
  const userID = user?.id || "";
  if (!workspaceID || !userID) return [];
  const local = loadChannelOrder(workspaceID, userID);
  if (reorderedThisSession.has(cacheScope(workspaceID, userID))) return local;
  const server = serverChannelOrder(user, workspaceID);
  const merged = mergeChannelOrder(server, local);
  if (server !== undefined) writeChannelOrderCache(workspaceID, userID, merged);
  return merged;
}

// storeChannelOrder records a reorder: the cache first so the sidebar never
// waits on the network, then a debounced account write.
export function storeChannelOrder(
  workspaceID: string,
  userID: string,
  order: string[],
  request: ChannelOrderRequest,
) {
  if (!workspaceID || !userID) return;
  reorderedThisSession.add(cacheScope(workspaceID, userID));
  writeChannelOrderCache(workspaceID, userID, order);
  queueChannelOrderPatch(workspaceID, userID, order, request);
}

export function channelOrderPatchBody(
  workspaceID: string,
  order: readonly string[],
): ChannelOrderPatchBody {
  return {
    sidebar_preferences: {
      channel_order: { [workspaceID]: order.slice(0, MAX_ROAMING_CHANNEL_ORDER_IDS) },
    },
  };
}

export function queueChannelOrderPatch(
  workspaceID: string,
  userID: string,
  order: string[],
  request: ChannelOrderRequest,
) {
  if (!workspaceID || !userID) return;
  const key = cacheScope(workspaceID, userID);
  const pending = pendingPatches.get(key);
  if (pending) clearTimeout(pending.timer);
  const body = channelOrderPatchBody(workspaceID, order);
  const timer = setTimeout(() => {
    pendingPatches.delete(key);
    void sendChannelOrderPatch(request, body, false);
  }, CHANNEL_ORDER_PATCH_DEBOUNCE_MS);
  pendingPatches.set(key, { timer, body });
}

// flushChannelOrderPatches sends every debounced write immediately, for the
// moment the page is going away. keepalive lets the request outlive the
// document, so a reorder made just before a tab closes still roams.
export function flushChannelOrderPatches(request: ChannelOrderRequest) {
  if (pendingPatches.size === 0) return;
  const flushing = [...pendingPatches.values()];
  pendingPatches.clear();
  for (const pending of flushing) {
    clearTimeout(pending.timer);
    void sendChannelOrderPatch(request, pending.body, true);
  }
}

async function sendChannelOrderPatch(
  request: ChannelOrderRequest,
  body: ChannelOrderPatchBody,
  keepalive: boolean,
) {
  try {
    await request("/api/me", {
      method: "PATCH",
      body: JSON.stringify(body),
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    // Best effort. The order stays on this device and the next reorder retries.
    console.warn("channel order save failed", error);
  }
}
