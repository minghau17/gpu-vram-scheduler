'use strict';
/**
 * build.js — 打包成免安装的 Windows 目录版（dist/GPU调度管理器-win32-x64）。
 * 用法：node scripts/build.js
 */
const path = require('path');
const fs = require('fs');
const packager = require('@electron/packager').packager;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ICON = path.join(ROOT, 'assets', 'icons', 'app.ico');

const ignore = [
  /^\/dist($|\/)/,
  /^\/docs($|\/)/,
  /^\/scripts($|\/)/,
  /^\/data($|\/)/,
  /^\/\.git($|\/)/,
  /^\/renderer\/effects($|\/)/,
  /\.map$/,
];

(async () => {
  if (!fs.existsSync(ICON)) throw new Error('缺少图标 app.ico，先跑 npm run icons');
  const out = await packager({
    dir: ROOT,
    out: OUT,
    name: 'GPU调度管理器',
    executableName: 'GPU调度管理器',
    platform: 'win32',
    arch: 'x64',
    icon: ICON,
    asar: true,
    overwrite: true,
    prune: true,
    ignore,
    appVersion: require(path.join(ROOT, 'package.json')).version,
    win32metadata: {
      CompanyName: 'GPU Scheduler',
      FileDescription: 'GPU 调度管理器 · 显存智能调度',
      ProductName: 'GPU 调度管理器',
      InternalName: 'GPU Scheduler',
      OriginalFilename: 'GPU调度管理器.exe',
    },
  });
  console.log('[build] done: ' + out.join(', '));
})().catch((e) => { console.error('[build] failed', e); process.exit(1); });
