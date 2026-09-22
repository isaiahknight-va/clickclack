import test from "node:test";
import assert from "node:assert/strict";
import {
  appleDevice,
  applicationServerKey,
  deviceLabel,
  pushSupported,
} from "./push-capability.ts";

const globals = globalThis as {
  navigator?: unknown;
  window?: unknown;
};

function withEnvironment(navigatorValue: unknown, windowValue: unknown, run: () => void) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globals, "navigator");
  const previousWindow = Object.getOwnPropertyDescriptor(globals, "window");
  Object.defineProperty(globals, "navigator", { value: navigatorValue, configurable: true });
  Object.defineProperty(globals, "window", { value: windowValue, configurable: true });
  try {
    run();
  } finally {
    if (previousNavigator) Object.defineProperty(globals, "navigator", previousNavigator);
    else delete globals.navigator;
    if (previousWindow) Object.defineProperty(globals, "window", previousWindow);
    else delete globals.window;
  }
}

test("applicationServerKey decodes an unpadded base64url VAPID key", () => {
  // The RFC 8291 example application server key: 65 bytes, uncompressed point.
  const key =
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const bytes = applicationServerKey(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.equal(bytes[64], 0x0f);
});

test("pushSupported requires the service worker, the push manager, and notifications", () => {
  const complete = { serviceWorker: {} };
  withEnvironment(complete, { PushManager: class {}, Notification: class {} }, () => {
    assert.equal(pushSupported(), true);
  });
  // An iOS Safari tab has a service worker but no push manager.
  withEnvironment(complete, { Notification: class {} }, () => {
    assert.equal(pushSupported(), false);
  });
  withEnvironment({}, { PushManager: class {}, Notification: class {} }, () => {
    assert.equal(pushSupported(), false);
  });
});

test("appleDevice recognizes an iPad reporting a desktop user agent", () => {
  const ipad =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  withEnvironment({ userAgent: ipad, maxTouchPoints: 5 }, {}, () => {
    assert.equal(appleDevice(), true);
  });
  withEnvironment({ userAgent: ipad, maxTouchPoints: 0 }, {}, () => {
    assert.equal(appleDevice(), false);
  });
  withEnvironment(
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 },
    {},
    () => {
      assert.equal(appleDevice(), true);
    },
  );
  withEnvironment({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 }, {}, () => {
    assert.equal(appleDevice(), false);
  });
});

test("deviceLabel names the platform and browser without copying the user agent", () => {
  assert.equal(
    deviceLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    ),
    "iPhone Safari",
  );
  assert.equal(
    deviceLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    ),
    "Mac Chrome",
  );
  assert.equal(deviceLabel("something else entirely"), "This device");
});
