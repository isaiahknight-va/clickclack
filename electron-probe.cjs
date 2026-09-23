// Real-Electron probe of the tray image, head (no resize) vs parent (resize).
const path = require("node:path");
const { app, nativeImage } = require("electron");
const assets = process.argv.at(-1);
const describe = (label, image) =>
  console.log(
    `${label}: template=${image.isTemplateImage()} size=${JSON.stringify(image.getSize())} scaleFactors=${JSON.stringify(image.getScaleFactors())} empty=${image.isEmpty()}`,
  );
app.whenReady().then(() => {
  console.log(`electron=${process.versions.electron} platform=${process.platform} assets=${assets}`);
  const fresh = nativeImage.createFromPath(path.join(assets, "trayTemplate.png"));
  describe("createFromPath only (before setTemplateImage)", fresh);
  const head = nativeImage.createFromPath(path.join(assets, "trayTemplate.png"));
  head.setTemplateImage(true);
  describe("HEAD createTray (setTemplateImage(true), no resize)", head);
  const parentSource = nativeImage.createFromPath(path.join(assets, "trayTemplate.png"));
  parentSource.setTemplateImage(true);
  describe("PARENT createTray (setTemplateImage(true) then resize({ height: 18 }))", parentSource.resize({ height: 18 }));
  app.quit();
});
