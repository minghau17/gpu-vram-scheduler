'use strict';
/**
 * main.js — 主进程：窗口、IPC、桥接采集、A/B 实测、自动分流、报告导出。
 * 渲染进程只能通过 preload 暴露的 api 访问这里，禁止直连 Node。
 */
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const bridge = require('./bridge');
const { MeasureEngine } = require('./measure');

const IS_DEV = process.argv.includes('--dev');
// 开发用：--shot=<png 路径> 启动后自动截图并退出；--page=<dashboard|apps|insights|settings>
const argOf = (k) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const SHOT = argOf('shot');
const SHOT_PAGE = argOf('page') || 'dashboard';
const SHOT_WAIT = Number(argOf('wait') || 6000);
const QA_DIR = argOf('qa');
const DEV_SCRIPT = argOf('devscript');
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const ICON = path.join(ROOT, 'assets', 'icons', 'app.ico');

let mainWindow = null;
let latestSnapshot = null;
let savingsCache = { totalFreedMB: 0, sessions: [] };
let settings = null;

const measure = new MeasureEngine({
  getSnapshot: () => latestSnapshot,
  setPreference: (p, pref) => bridge.setPreference(p, pref),
  onUpdate: (state) => send('measure:state', state),
});

// ───────────────────────── 工具 ─────────────────────────

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload); } catch (_) { /* ignore */ }
  }
}

function readSettings() {
  if (settings) return settings;
  try {
    settings = Object.assign({
      interval: 2000,
      theme: 'light',
      autoRules: false,
      autoCategories: ['浏览器', '通讯', '办公', '下载'],
      reduceMotion: false,
      glassLevel: 'high',
    }, bridge.getSettings() || {});
  } catch (_) {
    settings = { interval: 2000, theme: 'light', autoRules: false, autoCategories: [], reduceMotion: false, glassLevel: 'high' };
  }
  return settings;
}

function pushSettings(patch) {
  const current = readSettings();
  const next = Object.assign({}, current, patch || {});
  settings = next;
  // 只把桥关心的字段写进 state.json，UI 偏好也一起存，换机器不至于丢
  try { bridge.saveSettings(next); } catch (_) { /* ignore */ }
  return next;
}

// ───────────────────────── 窗口 ─────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    icon: ICON,
    title: 'GPU 调度管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'), { query: { page: SHOT_PAGE } });
  if (SHOT) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, SHOT_WAIT));
      try {
        // 截图前把鼠标悬停态清掉，避免把 tooltip 一起拍进去
        await mainWindow.webContents.executeJavaScript(
          `(()=>{const v=document.getElementById('view'); if(v) v.dispatchEvent(new MouseEvent('mouseleave')); const t=document.getElementById('chartTip'); if(t) t.style.opacity=0; return 1;})()`,
          true
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 260));
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(SHOT, img.toPNG());
        console.log('[shot] ' + SHOT);
      } catch (e) { console.error('[shot] failed', e); }
      app.quit();
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV_SCRIPT) {
      try {
        require(path.join(ROOT, 'scripts', DEV_SCRIPT + '.js'))(mainWindow, {
          measure,
          bridge,
          collect,
          getSnapshot: () => latestSnapshot,
        }).catch((e) => console.error('[devscript]', e)).finally(() => setTimeout(() => app.quit(), 1500));
      } catch (e) { console.error('[devscript] load failed', e); }
    }
    if (QA_DIR) {
      const runQa = require('../scripts/qa-run');
      runQa(mainWindow, QA_DIR).catch((e) => console.error('[qa] failed', e)).finally(() => app.quit());
    }
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  const emitWindowState = () => send('window:state', {
    maximized: mainWindow.isMaximized(),
    focused: mainWindow.isFocused(),
  });
  ['maximize', 'unmaximize', 'focus', 'blur', 'resize'].forEach((ev) => mainWindow.on(ev, emitWindowState));
  mainWindow.on('closed', () => { mainWindow = null; });

  // 打开外部链接一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ───────────────────────── 状态负载 ─────────────────────────

function computeInsights(snap) {
  const apps = snap && Array.isArray(snap.apps) ? snap.apps : [];
  const movable = apps.filter((a) => a.category !== '系统' && a.exePath);
  // 已经设为核显但进程还没重启 —— 这些占用马上就要还回来
  const pendingMB = movable
    .filter((a) => a.preference === 1 && (a.dgpuMB || 0) > 8)
    .reduce((s, a) => s + Math.round(a.dgpuMB || 0), 0);
  // 建议迁移（推荐核显但当前还没设）—— 预估可释放
  const suggested = movable
    .filter((a) => a.preference !== 1 && a.recommended === 1 && (a.dgpuMB || 0) > 8)
    .sort((a, b) => (b.dgpuMB || 0) - (a.dgpuMB || 0));
  const suggestMB = suggested.reduce((s, a) => s + Math.round(a.dgpuMB || 0), 0);
  const dgpu = (snap && snap.adapters ? snap.adapters : []).find((a) => a.kind === 'dgpu') || null;
  return {
    pendingMB,
    pendingCount: movable.filter((a) => a.preference === 1 && (a.dgpuMB || 0) > 8).length,
    suggestMB,
    suggestCount: suggested.length,
    suggestTop: suggested.slice(0, 6).map((a) => ({
      exePath: a.exePath, name: a.name, dgpuMB: Math.round(a.dgpuMB || 0), category: a.category,
    })),
    freeMB: dgpu ? Math.max(0, (dgpu.totalMB || 0) - (dgpu.usedMB || 0)) : 0,
  };
}

function buildStatePayload() {
  const snap = latestSnapshot || { ts: Date.now(), adapters: [], apps: [], totals: {}, watchList: [] };
  let liveDataDir = DATA_DIR;
  try { liveDataDir = (bridge.getSettings() || {}).dataDir || DATA_DIR; } catch (_) { /* ignore */ }
  return {
    snapshot: snap,
    insights: computeInsights(snap),
    savings: savingsCache,
    settings: readSettings(),
    measure: measure.state,
    engine: bridge.getEngineInfo(),
    dataDir: liveDataDir,
    version: app.getVersion(),
    platform: process.platform,
  };
}

// ───────────────────────── 自动分流 ─────────────────────────
// 只对「从未手动设置过」的新面孔生效，且同一个 exe 只自动处理一次，避免和用户抢方向盘。
const autoSeen = new Set();

async function runAutoRules(snap) {
  const s = readSettings();
  if (!s.autoRules) return;
  const cats = Array.isArray(s.autoCategories) ? s.autoCategories : [];
  if (!cats.length) return;
  const apps = snap && Array.isArray(snap.apps) ? snap.apps : [];
  for (const a of apps) {
    if (!a.exePath || a.preference != null) continue;
    if (a.category === '系统' || !cats.includes(a.category)) continue;
    const k = a.exePath.toLowerCase();
    if (autoSeen.has(k)) continue;
    autoSeen.add(k);
    if (a.recommended !== 1) continue;
    const r = await bridge.setPreference(a.exePath, 1);
    if (r && r.ok) send('auto:applied', { exePath: a.exePath, name: a.name, pref: 1 });
  }
}

// ───────────────────────── 采集循环 ─────────────────────────

async function collect() {
  const snap = await bridge.collectOnce();
  latestSnapshot = snap;
  try { savingsCache = bridge.getSavings(); } catch (_) { /* ignore */ }
  send('tick', buildStatePayload());
  try { await measure.onTick(snap); } catch (_) { /* ignore */ }
  try { await runAutoRules(snap); } catch (_) { /* ignore */ }
  return snap;
}

// ───────────────────────── IPC ─────────────────────────

function registerIpc() {
  ipcMain.handle('state:get', async () => {
    if (!latestSnapshot) await collect();
    return buildStatePayload();
  });

  ipcMain.handle('app:setPreference', async (_e, { path: p, pref }) => {
    const r = await bridge.setPreference(p, pref);
    await collect();
    return r;
  });

  ipcMain.handle('app:bulk', async (_e, { paths, pref }) => {
    const list = Array.isArray(paths) ? paths : [];
    const results = [];
    for (const p of list) {
      // 串行写注册表，避免 powershell 并发
      results.push(await bridge.setPreference(p, pref));
    }
    await collect();
    return { ok: results.every((r) => r && r.ok), results, count: results.filter((r) => r && r.ok).length };
  });

  ipcMain.handle('app:restoreDefault', async (_e, { path: p }) => {
    const r = await bridge.restoreDefault(p);
    await collect();
    return r;
  });

  ipcMain.handle('app:smartOptimize', async () => bridge.smartOptimize());

  ipcMain.handle('app:add', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要调度的程序',
      properties: ['openFile'],
      filters: [{ name: '程序', extensions: ['exe'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    const list = bridge.getWatchList();
    if (!list.some((x) => String(x.exePath).toLowerCase() === file.toLowerCase())) {
      list.push({ exePath: file, name: path.basename(file, '.exe'), addedAt: Date.now() });
      bridge.saveWatchList(list);
    }
    await collect();
    return { ok: true, exePath: file, name: path.basename(file, '.exe') };
  });

  ipcMain.handle('app:remove', async (_e, { path: p }) => {
    const list = bridge.getWatchList().filter((x) => String(x.exePath).toLowerCase() !== String(p).toLowerCase());
    bridge.saveWatchList(list);
    await collect();
    return { ok: true };
  });

  ipcMain.handle('app:revealInExplorer', (_e, { path: p }) => {
    try { shell.showItemInFolder(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:launch', async (_e, { path: p }) => {
    try { await shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:restart', async (_e, { path: p, pids }) => {
    try {
      const list = Array.isArray(pids) ? pids : [];
      for (const pid of list) {
        try { process.kill(pid); } catch (_) { /* 已退出 */ }
      }
      await new Promise((r) => setTimeout(r, 1200));
      await shell.openPath(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = pushSettings(patch);
    if (patch && patch.interval && patch.interval !== bridge._interval) {
      try { await bridge.startPolling(Number(patch.interval)); } catch (_) { /* ignore */ }
    }
    if (patch && patch.theme) { try { nativeTheme.themeSource = patch.theme === 'dark' ? 'dark' : 'light'; } catch (_) { /* ignore */ } }
    await collect();
    return next;
  });

  ipcMain.handle('history:get', (_e, { minutes = 10 } = {}) => {
    try { return bridge.getHistory(minutes); } catch (_) { return []; }
  });

  ipcMain.handle('measure:start', async (_e, opts) => {
    try { return await measure.start(opts || {}); } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('measure:cancel', () => measure.cancel('用户取消'));
  ipcMain.handle('measure:reset', () => measure.reset());
  ipcMain.handle('measure:state', () => measure.state);

  ipcMain.handle('report:export', async () => {
    try {
      const md = buildReport();
      const dir = path.join(DATA_DIR, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `显存报告-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
      fs.writeFileSync(file, md, 'utf8');
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('shell:openGraphicsSettings', async () => {
    try { await shell.openExternal('ms-settings:display-advancedgraphics'); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('shell:openDataDir', async () => { shell.openPath(DATA_DIR); return { ok: true }; });

  ipcMain.handle('window:minimize', () => { mainWindow && mainWindow.minimize(); });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => { mainWindow && mainWindow.close(); });
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }));
}

function buildReport() {
  const snap = latestSnapshot || { apps: [], adapters: [], totals: {} };
  const ins = computeInsights(snap);
  const dgpu = (snap.adapters || []).find((a) => a.kind === 'dgpu') || {};
  const igpu = (snap.adapters || []).find((a) => a.kind === 'igpu') || {};
  const sessions = (savingsCache.sessions || []).filter((s) => s.status === 'applied').slice(-12);
  const L = [];
  L.push('# GPU 显存调度报告');
  L.push('');
  L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- 独显：${dgpu.name || '未知'} ${dgpu.usedMB || 0} / ${dgpu.totalMB || 0} MB`);
  L.push(`- 核显：${igpu.name || '未知'} ${igpu.usedMB || 0} / ${igpu.totalMB || 0} MB`);
  L.push(`- 可释放（待重启生效）：${ins.pendingMB} MB`);
  L.push(`- 建议迁移预估：${ins.suggestMB} MB（${ins.suggestCount} 个程序）`);
  L.push(`- 已实测释放累计：${savingsCache.totalFreedMB || 0} MB`);
  L.push('');
  L.push('## 实测会话');
  if (!sessions.length) L.push('_还没有完成过实测，去「收益实测」跑一次。_');
  else {
    L.push('| 程序 | 切换前 | 切换后 | 释放 | 时间 |');
    L.push('|---|---|---|---|---|');
    for (const s of sessions) {
      L.push(`| ${s.name || s.exePath} | ${Math.round(s.beforeDgpuMB || 0)} MB | ${Math.round(s.afterDgpuMB || 0)} MB | ${Math.round(s.freedMB || 0)} MB | ${new Date(s.beforeAt || s.appliedAt || Date.now()).toLocaleString('zh-CN')} |`);
    }
  }
  L.push('');
  L.push('## 建议迁移清单');
  L.push('| 程序 | 当前独显占用 | 分类 |');
  L.push('|---|---|---|');
  for (const a of ins.suggestTop) L.push(`| ${a.name} | ${a.dgpuMB} MB | ${a.category || '-'} |`);
  L.push('');
  L.push('## 当前占用 Top 10');
  L.push('| 程序 | 独显 | 偏好 |');
  L.push('|---|---|---|');
  const top = (snap.apps || []).slice().sort((a, b) => (b.dgpuMB || 0) - (a.dgpuMB || 0)).slice(0, 10);
  for (const a of top) L.push(`| ${a.name} | ${Math.round(a.dgpuMB || 0)} MB | ${a.preference === 1 ? '核显' : a.preference === 2 ? '独显' : '自动'} |`);
  L.push('');
  L.push('> 数据来源：Windows 性能计数器 \\GPU Process Memory(*)\\Dedicated Usage（逐进程真实显存）+ NVML。');
  return L.join('\n');
}

// ───────────────────────── 启动 ─────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    const themeArg = argOf('theme');
    if (themeArg) pushSettings({ theme: themeArg });
    nativeTheme.themeSource = readSettings().theme === 'dark' ? 'dark' : 'light';
    registerIpc();
    createWindow();

    try {
      await bridge.init({ dataDir: DATA_DIR });
      bridge.setLogger((m) => { if (IS_DEV) console.log(m); });
      bridge.on('tick', () => { try { savingsCache = bridge.getSavings(); } catch (_) { /* ignore */ } });
      await collect();
      await bridge.startPolling(Number(readSettings().interval) || 2000);
    } catch (e) {
      console.error('[main] bridge init failed', e);
    }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => {
    try { bridge.destroy(); } catch (_) { /* ignore */ }
    app.quit();
  });
}
