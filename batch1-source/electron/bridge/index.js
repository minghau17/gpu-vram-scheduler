'use strict';
/**
 * index.js — GPU Scheduler 2.0 后端桥（纯 Node，CommonJS，不依赖 Electron API）。
 *
 * SPEC「后端契约」的唯一入口。创建单例并导出，直接用：
 *   const bridge = require('./electron/bridge');
 *   await bridge.init({ dataDir });
 *   await bridge.startPolling(2000);
 *   bridge.on('tick', snapshot => ...);
 *
 * 采集链：
 *   counters.js  (常驻 powershell.exe，PDH + DXGI，单行 JSON / 次，实测 19~45ms)
 *     -> adapters.js (LUID -> 适配器名/厂商/kind/总量，nvidia-smi 校准) 
 *     -> apps.js     (按 exe 聚合多进程、中文分类、推荐、iconUrl)
 *     -> savings.js  (释放量化状态机 + 证据字段，落盘 data/state.json)
 *     -> history.js  (内存环形缓冲)
 *
 * 所有公开方法都做了容错：数据源缺失/进程退出/权限不足时返回空数组、null 或 degraded 快照，
 * 不抛未捕获异常（Electron 主进程不能被这里拖崩）。
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { Store } = require('./store');
const { CounterCollector } = require('./counters');
const { Prefs } = require('./prefs');
const { buildApps, classify } = require('./apps');
const { buildAdapters, queryNvidiaSmi, findAdapter } = require('./adapters');
const { SavingsEngine } = require('./savings');
const { History } = require('./history');
const { Catalog } = require('./catalog');
const { Icons } = require('./icons');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const DEFAULT_INTERVAL_MS = 2000;
const NV_SMI_REFRESH_MS = 30000;
const EMPTY_TOTALS = {
  dgpuTotalMB: 0,
  dgpuUsedMB: 0,
  dgpuFreeMB: 0,
  igpuUsedMB: 0,
  igpuTotalMB: 0,
  appsCount: 0,
  onIgpu: 0,
  onDgpu: 0,
  onDefault: 0,
};

class Bridge extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._initialized = false;
    this._initPromise = null;
    this._destroyed = false;
    this._dataDir = null;
    this._logFn = (() => {
      if (process.env.GPU_SCHEDULER_DEBUG || process.env.GPU_SCHEDULER_LOG) {
        return (...args) => { try { console.log(...args); } catch (_) { /* ignore */ } };
      }
      return null;
    })();

    this._store = null;
    this._prefs = null;
    this._counters = null;
    this._icons = null;
    this._catalog = null;
    this._savings = null;
    this._history = null;

    this._snapshot = null;
    this._nvsmi = null;
    this._nvsmiAt = 0;
    this._nvsmiPending = false;
    this._prefsBusy = false;
    this._prefsRefreshing = false;

    this._interval = DEFAULT_INTERVAL_MS;
    this._polling = false;
    this._pollTimer = null;
    this._collecting = null;
    this._lastError = null;
    this._exitHookBound = false;
    this._iconsWarmed = false;
  }

  // ───────────────────────── logging / init ─────────────────────────

  setLogger(fn) {
    this._logFn = typeof fn === 'function' ? fn : null;
    return this;
  }

  log(msg) {
    if (!this._logFn) return;
    try { this._logFn(msg); } catch (_) { /* ignore */ }
  }

  _reportError(err, context) {
    const msg = (context ? context + ': ' : '') + (err && err.message ? err.message : String(err));
    this._lastError = msg;
    this.log('[bridge] ' + msg);
    if (this.listenerCount('error') > 0) {
      try { this.emit('error', err instanceof Error ? err : new Error(msg)); } catch (_) { /* ignore */ }
    }
  }

  /** 初始化。幂等；可重复调用（参数只在第一次生效）。 */
  async init(opts) {
    const o = opts || {};
    if (this._initialized) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit(o).finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  async _doInit(o) {
    const dataDir = o.dataDir ? path.resolve(o.dataDir) : DEFAULT_DATA_DIR;
    this._dataDir = dataDir;
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { this.log('cannot create dataDir: ' + e.message); }

    this._store = new Store(dataDir);
    this._store.load();
    const settings = this._store.getState().settings || {};
    this._interval = Math.max(500, Number(settings.interval) || DEFAULT_INTERVAL_MS);

    this._prefs = new Prefs({ dataDir, logger: (m) => this.log(m) });
    this._icons = new Icons({ dataDir, logger: (m) => this.log(m) });
    this._catalog = new Catalog({ dataDir, logger: (m) => this.log(m) });
    this._savings = new SavingsEngine({ store: this._store });
    this._history = new History({ maxPoints: 12000 });

    // 这些初始化互相独立，失败都只降级不阻塞
    try { this._icons.init(); } catch (e) { this.log('icons init failed: ' + e.message); }
    try { this._catalog.init(); } catch (e) { this.log('catalog init failed: ' + e.message); }

    await this._prefs.init();
    this._counters = new CounterCollector({ dataDir, logger: (m) => this.log(m) });
    await this._counters.init();

    // nvidia-smi：拿独显总量/已用（任务管理器同源）。失败不影响采集。
    try { this._nvsmi = await queryNvidiaSmi(4000); } catch (_) { this._nvsmi = null; }
    this._nvsmiAt = Date.now();

    this._initialized = true;
    this._bindExitHook();
    this.log('[bridge] initialized; dataDir=' + dataDir + '; counters=' + (this._counters.getMeta().mode || 'none'));

    // 首次采样，让 UI 一打开就有数据
    try { await this.collectOnce(); } catch (e) { this._reportError(e, 'first sample'); }

    // 后台先把当前应用图标抽出来，抽完再推一个 tick 让 UI 立刻有图标
    this._warmIconsOnce().catch(() => { /* ignore */ });
    return this;
  }

  async _ensureInit() {
    if (!this._initialized) await this.init({});
    return this;
  }

  _bindExitHook() {
    if (this._exitHookBound) return;
    this._exitHookBound = true;
    const cleanup = () => { try { this._cleanupSync(); } catch (_) { /* ignore */ } };
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  }

  _cleanupSync() {
    try { if (this._pollTimer) clearTimeout(this._pollTimer); } catch (_) { /* ignore */ }
    this._polling = false;
    try { if (this._counters) this._counters.stop(); } catch (_) { /* ignore */ }
  }

  // ───────────────────────── 采样 / 轮询 ─────────────────────────

  /**
   * 立即采集一次，返回 SPEC snapshot 本体（不包装 {ok,data}）。
   * 每次采样后 emit('tick', snapshot)。
   */
  async collectOnce() {
    await this._ensureInit();
    if (this._destroyed) return this._snapshot || this._degradedSnapshot(new Error('bridge destroyed'));
    if (this._collecting) return this._collecting;   // 防重入：并发调用共享同一次采集
    this._collecting = this._doCollect().finally(() => { this._collecting = null; });
    return this._collecting;
  }

  async _doCollect() {
    let snapshot;
    try {
      snapshot = await this._buildSnapshot();
    } catch (e) {
      this._reportError(e, 'collect');
      snapshot = this._degradedSnapshot(e);
    }
    this._snapshot = snapshot;
    try { this._history.push(snapshot); } catch (_) { /* ignore */ }
    try {
      const savingsResult = this._savings.observe(snapshot);
      for (const s of savingsResult.applied) {
        this.log('[bridge] freed ' + s.freedMB + 'MB for ' + s.exePath);
        if (this.listenerCount('applied') > 0) { try { this.emit('applied', this._savings._publicSession(s)); } catch (_) { /* ignore */ } }
      }
      for (const s of savingsResult.needsRestart) {
        if (this.listenerCount('needs-restart') > 0) { try { this.emit('needs-restart', this._savings._publicSession(s)); } catch (_) { /* ignore */ } }
      }
    } catch (e) { this._reportError(e, 'savings'); }
    try { this.emit('tick', snapshot); } catch (e) { this._reportError(e, 'tick handler'); }
    return snapshot;
  }

  async _buildSnapshot() {
    const raw = await this._counters.collect();
    const meta = this._counters.getMeta();
    // 注册表缓存每 60s 后台刷新一次（用户在 Windows 设置里改偏好时，界面也能跟上）
    if (!this._prefsRefreshing && !this._prefsBusy && Date.now() - this._prefs.getLastRefreshAt() > 60000) {
      this._prefsRefreshing = true;
      this._prefs.refresh().finally(() => { this._prefsRefreshing = false; });
    }
    if (Date.now() - this._nvsmiAt > NV_SMI_REFRESH_MS && !this._nvsmiPending) {
      this._nvsmiPending = true;
      queryNvidiaSmi(4000)
        .then((r) => { this._nvsmi = r; this._nvsmiAt = Date.now(); })
        .catch(() => { /* ignore */ })
        .finally(() => { this._nvsmiPending = false; });
    }
    const adapters = buildAdapters(raw, meta, this._nvsmi);
    const apps = buildApps(raw, {
      prefs: this._prefs,
      adapters,
      iconUrlFor: (exePath) => (this._icons ? this._icons.getCachedUrl(exePath) : null),
    });
    const dgpu = findAdapter(adapters, 'dgpu');
    const igpu = findAdapter(adapters, 'igpu');
    const totals = {
      dgpuTotalMB: dgpu ? dgpu.totalMB : 0,
      dgpuUsedMB: dgpu ? dgpu.usedMB : 0,
      dgpuFreeMB: dgpu ? Math.max(0, (dgpu.totalMB || 0) - (dgpu.usedMB || 0)) : 0,
      igpuUsedMB: igpu ? igpu.usedMB : 0,
      igpuTotalMB: igpu ? igpu.totalMB : 0,
      appsCount: apps.length,
      onIgpu: apps.filter((a) => a.preference === 1).length,
      onDgpu: apps.filter((a) => a.preference === 2).length,
      onDefault: apps.filter((a) => a.preference == null || a.preference === 0).length,
    };
    return {
      ts: Number(raw.ts) || Date.now(),
      adapters,
      apps,
      totals,
      // ── 以下为契约外的补充字段（只增不改，Lead 可忽略）──
      engineInfo: this.getEngineInfo(),
      prefsCount: this._prefs ? this._prefs.entries.length : 0,
      watchList: this.getWatchList(),
      interval: this._interval,
      degraded: !!(meta.degraded || meta.mode !== 'resident'),
    };
  }

  _degradedSnapshot(err) {
    return {
      ts: Date.now(),
      adapters: this._snapshot ? this._snapshot.adapters : [],
      apps: [],
      totals: Object.assign({}, EMPTY_TOTALS),
      engineInfo: this.getEngineInfo(),
      prefsCount: this._prefs ? this._prefs.entries.length : 0,
      watchList: this.getWatchList(),
      interval: this._interval,
      degraded: true,
      error: err && err.message ? err.message : String(err || 'collect failed'),
    };
  }

  /** 开始轮询：立即采一次，之后每 intervalMs 一次（上一轮结束后再排下一轮，不会堆积）。 */
  async startPolling(intervalMs) {
    await this._ensureInit();
    const ms = Math.max(500, Number(intervalMs) || this._interval || DEFAULT_INTERVAL_MS);
    this._interval = ms;
    // 先停掉旧循环（含已排队的 timer），再用 generation 让在途的旧循环自行退出
    this._pollGen = (this._pollGen || 0) + 1;
    const gen = this._pollGen;
    this.stopPolling();
    this._polling = true;
    const loop = async () => {
      if (!this._polling || this._destroyed || gen !== this._pollGen) return;
      try { await this.collectOnce(); } catch (e) { this._reportError(e, 'poll'); }
      if (!this._polling || this._destroyed || gen !== this._pollGen) return;
      this._pollTimer = setTimeout(loop, this._interval);
      if (this._pollTimer.unref) this._pollTimer.unref();
    };
    this._pollTimer = setTimeout(loop, 0);
    if (this._pollTimer.unref) this._pollTimer.unref();
    return this;
  }

  stopPolling(clearTimer = true) {
    this._polling = false;
    if (clearTimer !== false && this._pollTimer) {
      try { clearTimeout(this._pollTimer); } catch (_) { /* ignore */ }
    }
    this._pollTimer = null;
    return this;
  }

  /** 兼容别名（Lead 若用 bridge.stop() 也可） */
  stop() { return this.stopPolling(); }

  isPolling() { return this._polling; }
  getSnapshot() { return this._snapshot; }

  async _warmIconsOnce() {
    if (this._iconsWarmed || !this._icons || !this._snapshot) return;
    this._iconsWarmed = true;
    const paths = (this._snapshot.apps || []).map((a) => a.exePath).filter(Boolean).slice(0, 40);
    if (paths.length === 0) return;
    this.log('[bridge] warming ' + paths.length + ' icons');
    try { await this._icons.warm(paths); } catch (_) { /* ignore */ }
    // 图标抽完后补推一个 tick，让 UI 首屏就有真实图标（若还在采样中则跳过）
    if (!this._destroyed && !this._collecting) {
      try { await this.collectOnce(); } catch (_) { /* ignore */ }
    }
  }

  // ───────────────────────── 偏好（注册表） ─────────────────────────

  /** 读某个 exe 当前偏好：0|1|2|null（同步，来自注册表缓存） */
  getPreference(exePath) {
    try { return this._prefs ? this._prefs.getPreference(exePath) : null; } catch (_) { return null; }
  }

  /** 主动重新读取整份 UserGpuPreferences（例如用户刚在 Windows 设置里改过）。 */
  async refreshPreferences() {
    try {
      if (!this._prefs || this._prefsBusy) return false;
      return await this._prefs.refresh();
    } catch (_) { return false; }
  }

  /**
   * 设置偏好：写注册表（保留 AppStatus 等其它 token），并开始释放量化。
   * @returns {Promise<{ok:boolean, exePath?:string, pref?:number, before?:object, after?:object, error?:string}>}
   */
  async setPreference(exePath, pref) {
    try {
      await this._ensureInit();
      if (!exePath || typeof exePath !== 'string') throw new TypeError('exePath required');
      const value = Number(pref);
      if (!(value === 0 || value === 1 || value === 2)) throw new TypeError('pref must be 0, 1 or 2');
      this._prefsBusy = true;
      const app = this._findApp(exePath);
      const beforeDgpuMB = app ? Math.max(0, Math.round(app.dgpuMB)) : 0;
      const pids = app && Array.isArray(app.pids) ? app.pids.slice() : [];
      const evidence = await this._prefs.setPreference(exePath, value);
      if (value === 1) {
        this._savings.begin({
          exePath,
          name: app ? app.name : path.basename(exePath),
          pref: value,
          beforeDgpuMB,
          pids,
          beforeAt: evidence.at || Date.now(),
          prefEvidence: { before: evidence.before, after: evidence.after },
        });
      } else {
        this._savings.cancel(exePath, 'preference -> ' + value);
      }
      if (app) app.preference = value;
      if (this.listenerCount('preference') > 0) {
        try { this.emit('preference', { exePath, pref: value, before: evidence.before, after: evidence.after }); } catch (_) { /* ignore */ }
      }
      return { ok: true, exePath, pref: value, before: evidence.before, after: evidence.after };
    } catch (e) {
      this._reportError(e, 'setPreference');
      return { ok: false, exePath, error: e.message };
    } finally {
      this._prefsBusy = false;
    }
  }

  /** 删除该 exe 的 GpuPreference（保留 AppStatus 等其它 token / 其它所有注册表值）。 */
  async restoreDefault(exePath) {
    try {
      await this._ensureInit();
      if (!exePath || typeof exePath !== 'string') throw new TypeError('exePath required');
      this._prefsBusy = true;
      const result = await this._prefs.restoreDefault(exePath);
      this._savings.cancel(exePath, 'restore default');
      const app = this._findApp(exePath);
      if (app) app.preference = null;
      return {
        ok: true,
        exePath,
        removed: result.removed,
        before: result.before,
        keptRaw: result.keptRaw,
      };
    } catch (e) {
      this._reportError(e, 'restoreDefault');
      return { ok: false, exePath, error: e.message };
    } finally {
      this._prefsBusy = false;
    }
  }

  _findApp(exePath) {
    if (!this._snapshot || !Array.isArray(this._snapshot.apps) || !exePath) return null;
    const key = String(exePath).toLowerCase();
    for (const app of this._snapshot.apps) {
      if (app.exePath && String(app.exePath).toLowerCase() === key) return app;
    }
    return null;
  }

  // ───────────────────────── 释放量化 / 优化建议 ─────────────────────────

  /** SPEC getSavings()：含 totalFreedMB 与每条 session 的证据字段。 */
  getSavings() {
    try {
      const s = this._savings.getSavings();
      return Object.assign({}, s, {
        engineInfo: this.getEngineInfo(),
      });
    } catch (e) {
      this._reportError(e, 'getSavings');
      return { totalFreedMB: 0, appliedCount: 0, pendingCount: 0, needsRestartCount: 0, cancelledCount: 0, lastFreedMB: 0, lastFreedAt: null, lastApplied: null, sessions: [], updatedAt: Date.now() };
    }
  }

  /**
   * 一键智能优化建议。返回 [{ exePath, name, estMB, pref }]（按预计可释放显存降序）。
   * estMB = 该应用当前在独显上的显存占用（走核显后预计可释放量）。
   * 系统类进程（dwm/csrss/...）一律不推荐。
   */
  async smartOptimize() {
    try {
      await this._ensureInit();
      let snap = this._snapshot;
      if (!snap) snap = await this.collectOnce();
      const suggestions = [];
      for (const app of snap.apps || []) {
        if (!app.exePath) continue;
        if (app.category === '系统') continue;
        const pref = Number(app.recommended);
        if (!(pref === 0 || pref === 1 || pref === 2)) continue;
        if (app.preference === pref) continue;
        if (pref === 0) continue;                       // 默认策略不算优化建议
        const estMB = pref === 1 ? Math.max(0, Math.round(app.dgpuMB || 0)) : 0;
        // 走核显但几乎不占独显的应用没有优化价值
        if (pref === 1 && estMB < 16 && !app.hasWindow) continue;
        suggestions.push({ exePath: app.exePath, name: app.name, estMB, pref });
      }
      suggestions.sort((a, b) => b.estMB - a.estMB || String(a.name).localeCompare(String(b.name)));
      return suggestions.slice(0, 40);
    } catch (e) {
      this._reportError(e, 'smartOptimize');
      return [];
    }
  }

  // ───────────────────────── 其它契约方法 ─────────────────────────

  /** 已安装应用目录（注册表卸载项 + 开始菜单快捷方式，缓存 10 分钟）。失败返回 []。 */
  async listInstalledApps(force) {
    try {
      await this._ensureInit();
      return await this._catalog.listInstalledApps(!!force);
    } catch (e) {
      this._reportError(e, 'listInstalledApps');
      return [];
    }
  }

  /** 环形缓冲历史 [{ts, dgpuUsedMB, igpuUsedMB}]，默认 30 分钟。 */
  getHistory(minutes) {
    try { return this._history.getHistory(minutes); } catch (_) { return []; }
  }

  getSettings() {
    try {
      const state = this._store ? this._store.getState() : null;
      return Object.assign({}, state ? state.settings : {}, { dataDir: this._dataDir || DEFAULT_DATA_DIR, interval: this._interval });
    } catch (_) {
      return { dataDir: this._dataDir || DEFAULT_DATA_DIR, interval: this._interval };
    }
  }

  /** 合并保存设置；interval 变化时若正在轮询会自动按新间隔重启轮询。 */
  saveSettings(patch) {
    try {
      if (!this._store) return this.getSettings();
      const state = this._store.getState();
      const next = Object.assign({}, state.settings, patch || {});
      if (next.interval != null) {
        const ms = Math.max(500, Number(next.interval) || DEFAULT_INTERVAL_MS);
        next.interval = ms;
        const changed = ms !== this._interval;
        this._interval = ms;
        state.settings = next;
        this._store.save();
        if (changed && this._polling) this.startPolling(ms).catch(() => { /* ignore */ });
      } else {
        state.settings = next;
        this._store.save();
      }
      return this.getSettings();
    } catch (e) {
      this._reportError(e, 'saveSettings');
      return this.getSettings();
    }
  }

  getWatchList() {
    try {
      const state = this._store ? this._store.getState() : null;
      const list = state && Array.isArray(state.watchList) ? state.watchList : [];
      return list.map((item) => Object.assign({}, item));
    } catch (_) { return []; }
  }

  /** 保存用户手动添加的应用列表 [{exePath,name,category?}]。 */
  saveWatchList(list) {
    try {
      const clean = Array.isArray(list)
        ? list.filter((x) => x && typeof x.exePath === 'string' && x.exePath).map((x) => ({
          exePath: x.exePath,
          name: x.name || path.basename(x.exePath),
          category: x.category || classify(x.exePath, x.name),
          addedAt: x.addedAt || Date.now(),
        }))
        : [];
      if (this._store) {
        const state = this._store.getState();
        state.watchList = clean;
        this._store.save();
      }
      return this.getWatchList();
    } catch (e) {
      this._reportError(e, 'saveWatchList');
      return [];
    }
  }

  /** exe 图标 PNG 绝对路径；抽不到返回 null（前端用首字母兜底）。 */
  async getIcon(exePath) {
    try {
      if (!this._icons) return null;
      return await this._icons.getIcon(exePath);
    } catch (e) {
      this._reportError(e, 'getIcon');
      return null;
    }
  }

  /** 图标 file:/// URL（同步，已缓存的才有）。 */
  getIconUrl(exePath) {
    try { return this._icons ? this._icons.getCachedUrl(exePath) : null; } catch (_) { return null; }
  }

  /** 设置页「数据源 / 采样耗时」信息。 */
  getEngineInfo() {
    const meta = this._counters ? this._counters.getMeta() : null;
    const adapters = this._snapshot ? this._snapshot.adapters : [];
    const mode = meta && (meta.mode === 'resident' || meta.mode === 'spawn') ? 'PDH+DXGI' : 'unavailable';
    return {
      mode,
      backend: meta ? meta.mode : 'none',                 // 'resident' 常驻 / 'spawn' 降级 / 'none'
      sampleMs: meta && meta.lastSampleMs != null ? meta.lastSampleMs : null,
      adapterCount: adapters.length,
      counters: meta ? meta.counters.length : 0,
      workerVersion: meta ? meta.workerVersion : null,
      workerPid: meta ? meta.psPid : null,
      nvidiaSmi: !!this._nvsmi,
      degraded: !!(meta && (meta.degraded || meta.mode !== 'resident')),
      lastError: meta && meta.lastError ? String(meta.lastError) : null,
      sampledAt: meta ? meta.lastSampleAt : null,
    };
  }

  /** 停止轮询并结束常驻 PowerShell 进程（Electron 退出前调用）。 */
  destroy() {
    this._destroyed = true;
    this.stopPolling();
    try { if (this._savings) this._savings.flush(); } catch (_) { /* ignore */ }
    try { if (this._counters) this._counters.stop(); } catch (_) { /* ignore */ }
    try { this.removeAllListeners(); } catch (_) { /* ignore */ }
    return this;
  }
}

const bridge = new Bridge();
bridge.Bridge = Bridge;

module.exports = bridge;