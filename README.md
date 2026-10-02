# Proof for openclaw/clickclack#284

Parent: origin/main 5781ea22. Fix: typ/sidebar-long-workspace-name cfda5b8d (its CSS,
embedded assets, and server are identical to fac53a68, where these were captured).
Workspace name: "Zainul Syafiq Worrkspace Note Clickclack" (from the issue).
Headless Chromium (Playwright 1.63), default 1280x720 viewport, external requests blocked.

## Files

- sidebar-before.png, sidebar-after.png: the sidebar cropped to its own box (260x720).
  Before: the name runs off the edge, the collapse chevron and both + buttons are gone,
  and the active channel row and the account presence dot are clipped.
  After: the name ends in an ellipsis and every control sits inside the sidebar.
- hit-test-before.json, hit-test-after.json: for four surfaces (web at 1280x720, the
  mobile drawer at 390x844, the desktop integrated title bar, and the desktop title bar
  with a long account name), the sidebar box and computed grid column, each control's
  box, whether it is inside the sidebar and the viewport, and which element wins
  document.elementFromPoint at its center; plus scrollWidth and clientWidth of the
  workspace name, the account name, and the desktop title bar workspace label.
- parent-failures.txt: tests/e2e/sidebar-long-workspace-name.spec.ts (as of cfda5b8d)
  run on a clean origin/main checkout with only the spec added.
- capture.cjs: the script that produced the screenshots and JSON.

## Reproduce

Run from a clickclack checkout after `pnpm install --frozen-lockfile`, so capture.cjs
resolves @playwright/test from the checkout. Outputs land next to capture.cjs.

    git checkout 5781ea22 && go build -o ../cc-parent ./apps/api/cmd/clickclack
    git checkout cfda5b8d && go build -o ../cc-child ./apps/api/cmd/clickclack
    ../cc-parent serve --addr 127.0.0.1:18620 --data ../proof-data --dev-bootstrap=true --access-log off &
    node <proof-dir>/capture.cjs http://127.0.0.1:18620 before   # then stop cc-parent
    ../cc-child serve --addr 127.0.0.1:18621 --data ../proof-data --dev-bootstrap=true --access-log off &
    node <proof-dir>/capture.cjs http://127.0.0.1:18621 after    # then stop cc-child

Both servers share one data directory so the bootstrap account (and its avatar color)
is identical in both captures. A rerun with a fresh data directory reproduces both
JSON files exactly; only the avatar color in the PNGs changes, since it derives from
the account id.
