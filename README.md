# Proof for "stop idle animations from redrawing the app"

- `headless-frames.md`: frames drawn in 10 seconds of an untouched page, headless Chromium (60 Hz), per build: `before` (main), `c1` (first commit), `after` (head). Raw results in `headless/`.
- `proof.mjs`, `run-proof.sh`: the headless harness. Each build runs a throwaway `--dev-bootstrap` server; the script traces 10 seconds and counts compositor draws and main-thread paints from the trace, and lists `document.getAnimations()` entries that are running.
- `desktop-144hz.md`, `desktop/*.json`, `harness-desktop.diff`: per-process CPU and frames on a 144 Hz Mac, v0.6.0 with a measurement-only main-process patch, without and with these CSS changes (candidates A and D; B and C are throttling variants, legend in `desktop-144hz.md`).
- `parent-failures.log`: `tests/e2e/idle-animations.spec.ts` run against `main` without the fix.
