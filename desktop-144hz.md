# Desktop measurements, 144 Hz

Mac mini (Apple M4), primary display 144 Hz. The desktop app was built from source at v0.6.0 (31d299ee) with a measurement-only main-process patch (`harness-desktop.diff`: a native title bar titled "ClickClack ENERGY TEST", no URL-scheme registration, windows shown without taking focus, environment switches for throttling and window opacity), identical in every candidate. Candidates: A is that build with the web app as on main; D adds only the two CSS changes in this PR; B (background throttling on, no CSS change) and C (background throttling on plus the CSS changes) were measured too and appear in the JSON files, but the PR does not change throttling. Background throttling is left as shipped (false) in A and D. CPU is per process, as a percent of one core, over a 60-second window; the states with a frame count were also traced for 10 seconds. The typing indicator and unread bar styles and components are byte-identical between 31d299ee and the PR's base.

| State | A renderer / GPU | A frames in 10 s | D renderer / GPU | D frames in 10 s |
|---|---|---|---|---|
| Idle DM, window visible | 1.61 / 1.27 | 1,445 draws | not measured visible (see note) | |
| Idle, closed to the tray (shown, then closed) | 1.58 / 1.45 | 1,442 draws | 0.13 / 0 | 0 |
| Idle, minimized | 1.37 / 1.18 | | 0.18 / 0 | |
| Unread bar open, window visible | 14.88 / 14.34 | 2,890 main-thread paints | | |
| Unread bar open, closed to the tray | 14.88 / 12.83 | | 0.23 / 0 | |

Sources: `desktop/wt.json` (visible states, A) and `desktop/wt-run6.json` (closed and minimized, A and D). Note: D was not measured with the window visible; the headless proof (`headless-frames.md`) covers the visible page, where the change takes an idle page from 600 frames in 10 seconds to none.
