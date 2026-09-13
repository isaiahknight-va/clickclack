import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CHANNEL_ORDER_PATCH_DEBOUNCE_MS,
  channelOrderPatchBody,
  flushChannelOrderPatches,
  channelOrderStorageKey,
  loadChannelOrder,
  MAX_CHANNEL_ID_LENGTH,
  MAX_ROAMING_CHANNEL_ORDER_IDS,
  mergeChannelOrder,
  parseChannelOrder,
  resolveChannelOrder,
  storeChannelOrder,
} from "./channel-order.ts";
import type { User } from "./types.ts";

function storage(t: TestContext, initial: Record<string, string> = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return values;
}

type RecordedRequest = { path: string; init: RequestInit };

// The module never imports a transport, so a test hands it this one.
function recorder() {
  const requests: RecordedRequest[] = [];
  const request = (path: string, init: RequestInit) => {
    requests.push({ path, init });
    return Promise.resolve({});
  };
  return { requests, request };
}

function rejectingRequest(t: TestContext) {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  return () => Promise.reject(new Error("offline"));
}

// Other tests in this file leave their own debounced writes in flight, so each
// assertion looks only at the workspace it just reordered.
function requestsFor(requests: RecordedRequest[], workspaceID: string) {
  return requests.filter((request) => String(request.init.body).includes(`"${workspaceID}"`));
}

function afterDebounce() {
  return new Promise((resolve) => setTimeout(resolve, CHANNEL_ORDER_PATCH_DEBOUNCE_MS + 150));
}

function user(id: string, channelOrder?: Record<string, string[]>): User {
  return {
    id,
    kind: "human",
    display_name: "Order Tester",
    handle: "order",
    avatar_url: "",
    created_at: "2026-09-13T00:00:00Z",
    ...(channelOrder ? { sidebar_preferences: { channel_order: channelOrder } } : {}),
  };
}

test("an account order replaces the local cache and is written back into it", (t) => {
  const values = storage(t, {
    [channelOrderStorageKey("wsp_1", "usr_1")]: JSON.stringify(["chn_a", "chn_b"]),
  });
  const resolved = resolveChannelOrder(user("usr_1", { wsp_1: ["chn_b", "chn_a"] }), "wsp_1");
  assert.deepEqual(resolved, ["chn_b", "chn_a"]);
  assert.deepEqual(loadChannelOrder("wsp_1", "usr_1"), ["chn_b", "chn_a"]);
  assert.equal(
    values.get(channelOrderStorageKey("wsp_1", "usr_1")),
    JSON.stringify(["chn_b", "chn_a"]),
  );
});

test("no account order leaves the cache alone and keeps serving it", (t) => {
  const values = storage(t, {
    [channelOrderStorageKey("wsp_2", "usr_2")]: JSON.stringify(["chn_a", "chn_b"]),
  });
  const resolved = resolveChannelOrder(user("usr_2"), "wsp_2");
  assert.deepEqual(resolved, ["chn_a", "chn_b"]);
  assert.equal(
    values.get(channelOrderStorageKey("wsp_2", "usr_2")),
    JSON.stringify(["chn_a", "chn_b"]),
  );
});

test("an account order for another workspace never touches this one", (t) => {
  const values = storage(t);
  const resolved = resolveChannelOrder(user("usr_3", { wsp_other: ["chn_a"] }), "wsp_3");
  assert.deepEqual(resolved, []);
  assert.equal(values.has(channelOrderStorageKey("wsp_3", "usr_3")), false);
});

test("a cleared account order clears the cache", (t) => {
  const values = storage(t, {
    [channelOrderStorageKey("wsp_4", "usr_4")]: JSON.stringify(["chn_a"]),
  });
  assert.deepEqual(resolveChannelOrder(user("usr_4", { wsp_4: [] }), "wsp_4"), []);
  assert.equal(values.has(channelOrderStorageKey("wsp_4", "usr_4")), false);
});

test("a reorder made in this session outlives a stale account snapshot", async (t) => {
  storage(t);
  const { request } = recorder();
  storeChannelOrder("wsp_5", "usr_5", ["chn_c", "chn_a"], request);
  const resolved = resolveChannelOrder(user("usr_5", { wsp_5: ["chn_a", "chn_c"] }), "wsp_5");
  assert.deepEqual(resolved, ["chn_c", "chn_a"]);
  await afterDebounce();
});

test("unavailable storage still resolves and still accepts a reorder", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem() {
          throw new Error("blocked storage");
        },
        setItem() {
          throw new Error("blocked storage");
        },
        removeItem() {
          throw new Error("blocked storage");
        },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const { request } = recorder();
  assert.deepEqual(resolveChannelOrder(user("usr_6", { wsp_6: ["chn_a"] }), "wsp_6"), ["chn_a"]);
  assert.doesNotThrow(() => storeChannelOrder("wsp_6", "usr_6", ["chn_a"], request));
  await afterDebounce();
});

test("a reorder writes the cache first and patches the account once after the debounce", async (t) => {
  const values = storage(t);
  const { requests, request } = recorder();
  storeChannelOrder("wsp_8", "usr_8", ["chn_a"], request);
  storeChannelOrder("wsp_8", "usr_8", ["chn_b", "chn_a"], request);
  assert.equal(
    values.get(channelOrderStorageKey("wsp_8", "usr_8")),
    JSON.stringify(["chn_b", "chn_a"]),
  );
  assert.equal(requestsFor(requests, "wsp_8").length, 0);
  await afterDebounce();
  const sent = requestsFor(requests, "wsp_8");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/api/me");
  assert.equal(sent[0].init.method, "PATCH");
  assert.equal(sent[0].init.keepalive, undefined);
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), {
    sidebar_preferences: { channel_order: { wsp_8: ["chn_b", "chn_a"] } },
  });
});

test("a flush sends the latest pending order once, with keepalive", async (t) => {
  storage(t);
  const { requests, request } = recorder();
  storeChannelOrder("wsp_10", "usr_10", ["chn_a"], request);
  storeChannelOrder("wsp_10", "usr_10", ["chn_b", "chn_a"], request);
  assert.equal(requestsFor(requests, "wsp_10").length, 0);

  flushChannelOrderPatches(request);
  const sent = requestsFor(requests, "wsp_10");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/api/me");
  assert.equal(sent[0].init.method, "PATCH");
  assert.equal(sent[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), {
    sidebar_preferences: { channel_order: { wsp_10: ["chn_b", "chn_a"] } },
  });

  // The flushed timer is gone, so the debounce cannot fire it a second time.
  await afterDebounce();
  assert.equal(requestsFor(requests, "wsp_10").length, 1);

  // A second flush with nothing pending sends nothing.
  flushChannelOrderPatches(request);
  assert.equal(requestsFor(requests, "wsp_10").length, 1);

  // A later reorder starts a fresh debounce.
  storeChannelOrder("wsp_10", "usr_10", ["chn_a", "chn_b"], request);
  assert.equal(requestsFor(requests, "wsp_10").length, 1);
  await afterDebounce();
  const resent = requestsFor(requests, "wsp_10");
  assert.equal(resent.length, 2);
  assert.equal(resent[1].init.keepalive, undefined);
  assert.deepEqual(JSON.parse(String(resent[1].init.body)), {
    sidebar_preferences: { channel_order: { wsp_10: ["chn_a", "chn_b"] } },
  });
});

test("a failed account patch leaves the local order in place", async (t) => {
  const values = storage(t);
  storeChannelOrder("wsp_9", "usr_9", ["chn_b", "chn_a"], rejectingRequest(t));
  await afterDebounce();
  assert.equal(
    values.get(channelOrderStorageKey("wsp_9", "usr_9")),
    JSON.stringify(["chn_b", "chn_a"]),
  );
  assert.deepEqual(loadChannelOrder("wsp_9", "usr_9"), ["chn_b", "chn_a"]);
});

test("an account order is sanitized the same way the cache is", () => {
  const tooLong = "x".repeat(MAX_CHANNEL_ID_LENGTH + 1);
  assert.deepEqual(mergeChannelOrder(["chn_a", "chn_a", "", tooLong, "chn_b"], []), [
    "chn_a",
    "chn_b",
  ]);
  assert.deepEqual(mergeChannelOrder(undefined, ["chn_a"]), ["chn_a"]);
  assert.deepEqual(mergeChannelOrder([], ["chn_a"]), []);
});

test("parseChannelOrder keeps its existing rules", () => {
  assert.deepEqual(parseChannelOrder(null), []);
  assert.deepEqual(parseChannelOrder("not-json"), []);
  assert.deepEqual(parseChannelOrder(JSON.stringify(["chn_a", "chn_a"])), ["chn_a"]);
  assert.deepEqual(parseChannelOrder(JSON.stringify(["chn_a", 7])), []);
  assert.deepEqual(
    parseChannelOrder(JSON.stringify(["chn_a", "x".repeat(MAX_CHANNEL_ID_LENGTH + 1)])),
    [],
  );
});

test("the patch body carries one workspace and stops at the roaming cap", () => {
  const order = Array.from({ length: MAX_ROAMING_CHANNEL_ORDER_IDS + 5 }, (_, i) => `chn_${i}`);
  const body = channelOrderPatchBody("wsp_7", order);
  assert.deepEqual(Object.keys(body.sidebar_preferences.channel_order), ["wsp_7"]);
  assert.equal(body.sidebar_preferences.channel_order.wsp_7.length, MAX_ROAMING_CHANNEL_ORDER_IDS);
  assert.equal(body.sidebar_preferences.channel_order.wsp_7[0], "chn_0");
});
