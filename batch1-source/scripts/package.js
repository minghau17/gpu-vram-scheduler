'use strict';
/**
 * package.js — 离线打包（不依赖下载 electron）：复制本地 electron dist，
 * 放入 app 目录，用 resedit 写入 exe 图标与版本信息。
 * 用法：node scripts/package.js
 * 产物：dist/GPU调度管理器-win32-x64/GPU调度管理器.exe
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'GPU调度管理器';
const TARGET = path.join(DIST, `${NAME}-win32-x64`);
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ICON = path.join(ROOT, 'assets', 'icons', 'app.ico');
const pkg = require(path.join(ROOT, 'package.json'));

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

(async () => {
  if (!fs.existsSync(ICON)) throw new Error('缺少 app.ico，先跑 npm run icons');
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) throw new Error('未找到本地 electron dist');

  rmrf(TARGET);
  copyDir(ELECTRON_DIST, TARGET);

  const exePath = path.join(TARGET, 'electron.exe');
  const newExe = path.join(TARGET, `${NAME}.exe`);
  fs.renameSync(exePath, newExe);

  // app 目录（不用 asar，便于排查；体积差异可忽略）
  const appDir = path.join(TARGET, 'resources', 'app');
  rmrf(path.join(TARGET, 'resources', 'default_app.asar'));
  copyDir(path.join(ROOT, 'electron'), path.join(appDir, 'electron'));
  copyDir(path.join(ROOT, 'renderer'), path.join(appDir, 'renderer'));
  copyDir(path.join(ROOT, 'assets'), path.join(appDir, 'assets'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));

  // 去掉开发用脚本与 demo
  for (const f of ['electron/mock.js', 'electron/bridge/test.js', 'renderer/effects']) {
    rmrf(path.join(appDir, f));
  }

  // 写入图标与版本信息
  try {
    const ResEdit = require('resedit');
    const { NtExecutable, NtExecutableResource, Resource, Data } = ResEdit;
    const exe = NtExecutable.from(fs.readFileSync(newExe), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);

    const iconFile = Data.IconFile.from(fs.readFileSync(ICON));
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 1033, iconFile.icons.map((i) => i.data)
    );

    const vis = Resource.VersionInfo.fromEntries(res.entries);
    if (vis && vis[0]) {
      const vi = vis[0];
      vi.setFileVersion(3, 0, 0, 0);
      vi.setProductVersion(3, 0, 0, 0);
      vi.setStringValues({ lang: 1033, codepage: 1200 }, {
        ProductName: 'GPU 调度管理器',
        FileDescription: 'GPU 调度管理器 · 显存智能调度',
        CompanyName: 'GPU Scheduler',
        InternalName: 'GPU Scheduler',
        OriginalFilename: `${NAME}.exe`,
        LegalCopyright: 'MIT License',
      });
      vi.outputToResourceEntries(res.entries);
    }
    res.outputResource(exe);
    fs.writeFileSync(newExe, Buffer.from(exe.generate()));
    console.log('[package] icon + version written');
  } catch (e) {
    console.warn('[package] 图标写入失败（exe 仍可用，只是图标是 electron 默认）：' + e.message);
  }

  // 交付说明
  fs.writeFileSync(path.join(DIST, '运行说明.txt'),
    `${NAME} v${pkg.version}\r\n\r\n1. 双击 GPU调度管理器-win32-x64\\${NAME}.exe 启动（免安装）\r\n2. 首次运行会在 %APPDATA%\\${NAME}\\data 建立配置与历史数据\r\n3. 把程序切到「核显」后，需要重启该程序才会真正释放显存\r\n4. 「收益实测」会用切换前后两次真实采样算出释放了多少 MB\r\n`, 'utf8');

  console.log('[package] done -> ' + newExe);
})().catch((e) => { console.error('[package] failed', e); process.exit(1); });
