# Proof for the macOS tray icon fix

- `before-dark-menu-bar-installed-0.3.1.png`: the right end of a dark menu bar on macOS 27.0 (26A428) with the released ClickClack 0.3.1 running. Its tray item is the faint dark disc between the play-button icon and the clock-arrow icon: a black bitmap on a black bar.
- `after-dark-menu-bar-fixed-build.png`: the same menu bar a minute later with the fixed build also running. Its item is the white two-keycap mark at the far left, left of the weather item, drawn white by macOS because the image is a template image. The 0.3.1 disc is still in its place for contrast.
- `electron-probe-output.txt`: `electron-probe.cjs` run with Electron 43.7.3 against the head assets, the parent asset, and the packaged `app.asar`, printing `isTemplateImage()`, the size, and the scale factors for the head's load path and the parent's load path.
- `before-0.3.1-item-levels-boosted.png`: the 0.3.1 item's slot cut from the before strip, as captured on the left and with the levels multiplied by 40 on the right, so the black bitmap (0x000000) separates from the bar (0x010101). Nothing else is edited.
