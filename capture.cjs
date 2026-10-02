// Headless proof for openclaw/clickclack#284.
// Usage, from a clickclack checkout with node_modules: node <path>/capture.cjs <base-url> <label>
// Writes sidebar-<label>.png (default 1280x720 viewport, cropped to the sidebar)
// and hit-test-<label>.json (geometry and hit tests for every sidebar surface).
const path = require("node:path");
const { chromium } = require(require.resolve("@playwright/test", { paths: [process.cwd()] }));

const [base, label] = process.argv.slice(2);
if (!base || !label) throw new Error("usage: node capture.cjs <base-url> <label>");
const longName = "Zainul Syafiq Worrkspace Note Clickclack";
const longAccount = "Zainul Syafiq Worrkspace Tester";
const desktopBridge = () => {
  Object.assign(window, {
    clickclackDesktop: {
      integratedTitleBar: true,
      notify: async () => true,
      onNavigate: () => () => {},
      onQuickCompose: () => () => {},
      openSettings: () => {},
      platform: "darwin",
      setActiveRoute: () => {},
      setUnreadCount: () => {},
      signInWithGitHub: async () => true,
    },
  });
};

function measure() {
  const sidebar = document.querySelector(".sidebar");
  const box = sidebar.getBoundingClientRect();
  const round = (rect) => ({
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
  });
  const control = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      rect: round(rect),
      inSidebar:
        rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom,
      inViewport:
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      topmost: hit === element || element.contains(hit),
      elementAtCenter: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : null,
    };
  };
  const text = (selector) => {
    const element = document.querySelector(selector);
    return element
      ? { text: element.textContent.trim(), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, truncated: element.scrollWidth > element.clientWidth }
      : null;
  };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    sidebar: { ...round(box), width: box.width, gridColumn: getComputedStyle(sidebar).gridTemplateColumns },
    createChannel: control('.sidebar [aria-label="Create channel"]'),
    startDirectMessage: control('.sidebar [aria-label="Start direct message"]'),
    collapseSidebar: control('.sidebar [aria-label="Collapse sidebar"]'),
    workspaceName: text(".sidebar .workspace-name-label"),
    accountName: text(".sidebar .user-card .user-meta strong"),
    titlebarWorkspace: text(".desktop-titlebar-workspace"),
  };
}

async function scenario(browser, { viewport, desktop = false, drawer = false, account = false, shot }) {
  const context = await browser.newContext({ baseURL: base, viewport });
  // Keep the run offline and deterministic: external avatars fall back to initials.
  await context.route((url) => url.origin !== new URL(base).origin, (route) => route.abort());
  const page = await context.newPage();
  const slug = `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await page.request.post("/api/workspaces", { data: { name: longName, slug } });
  if (!created.ok()) throw new Error(`workspace create failed: ${created.status()}`);
  const { workspace } = await created.json();
  const channel = await page.request.post(`/api/workspaces/${workspace.id}/channels`, {
    data: { name: "general", kind: "public" },
  });
  if (!channel.ok()) throw new Error(`channel create failed: ${channel.status()}`);
  if (account) {
    const bot = await page.request.post(`/api/workspaces/${workspace.id}/bots`, {
      data: { display_name: longAccount },
    });
    if (!bot.ok()) throw new Error(`bot create failed: ${bot.status()}`);
    await context.setExtraHTTPHeaders({ "X-ClickClack-User": (await bot.json()).bot.id });
  }
  if (desktop) await page.addInitScript(desktopBridge);
  await page.goto(`/app/${workspace.route_id}`);
  await page.locator('.shell[data-app-ready="true"]').waitFor();
  if (drawer) {
    await page.getByRole("button", { name: desktop ? "Open navigation" : "Toggle navigation" }).click();
    await page.waitForTimeout(400);
  }
  const result = await page.evaluate(measure);
  if (shot) {
    const box = await page.locator(".sidebar").boundingBox();
    await page.screenshot({ path: shot, clip: box, animations: "disabled" });
  }
  await context.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const out = {
    build: label,
    webDesktopSize: await scenario(browser, {
      viewport: { width: 1280, height: 720 },
      shot: path.join(__dirname, `sidebar-${label}.png`),
    }),
    mobileDrawer: await scenario(browser, { viewport: { width: 390, height: 844 }, drawer: true }),
    desktopTitleBar: await scenario(browser, { viewport: { width: 1280, height: 720 }, desktop: true }),
    desktopTitleBarLongAccount: await scenario(browser, {
      viewport: { width: 1280, height: 720 },
      desktop: true,
      account: true,
    }),
  };
  require("node:fs").writeFileSync(path.join(__dirname, `hit-test-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify(out));
})();
