'use strict';
/**
 * 图标栅格化：用 Electron 的 Chromium 把 logo.svg 渲染成各尺寸 PNG。
 * 用法：node_modules/.bin/electron scripts/make-icons.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icons', 'logo.svg');
const OUT = path.join(ROOT, 'assets', 'icons');
const SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  });
  const url = 'file:///' + SVG.replace(/\\/g, '/');
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 600));

  // 只以 1024 渲染一次，其余尺寸交给 Pillow 的 LANCZOS 高质量缩放（见 scripts/make-icons.py）
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(OUT, 'icon-1024.png'), img.toPNG());
  console.log('wrote icon-1024.png');
  // 托盘用 32
  fs.copyFileSync(path.join(OUT, 'icon-32.png'), path.join(OUT, 'tray-32.png'));
  fs.copyFileSync(path.join(OUT, 'icon-16.png'), path.join(OUT, 'tray-16.png'));

  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
