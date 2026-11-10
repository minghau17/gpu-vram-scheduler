'use strict';
/**
 * catalog.js — listInstalledApps(): 给「添加应用」用的已安装程序目录。
 * 数据源：卸载注册表项（DisplayIcon / InstallLocation）+ 开始菜单快捷方式（解析 .lnk 目标）。
 * 一次 PowerShell 调用 ~0.9s，结果缓存 10 分钟；失败返回 []（不抛异常）。
 */
const ps = require('./ps');

const SCRIPT_NAME = 'catalog.ps1';
const CACHE_TTL_MS = 10 * 60 * 1000;

class Catalog {
  constructor(opts) {
    const o = opts || {};
    this.dataDir = o.dataDir;
    this.logger = o.logger || null;
    this.scriptPath = null;
    this._cache = null;
    this._cachedAt = 0;
    this._inflight = null;
    this._lastError = null;
    this._meta = null;
  }

  log(msg) {
    if (this.logger && typeof this.logger === 'function') {
      try { this.logger('[bridge:catalog] ' + msg); } catch (_) { /* ignore */ }
    }
  }

  init() {
    try {
      this.scriptPath = ps.materializeScript(SCRIPT_NAME, this.dataDir);
      return true;
    } catch (e) {
      this.log('catalog unavailable: ' + e.message);
      this.scriptPath = null;
      return false;
    }
  }

  /**
   * @param {boolean} [force] ignore cache
   * @returns {Promise<Array<{exePath:string,name:string,source:string}>>}
   */
  async listInstalledApps(force) {
    const now = Date.now();
    if (!force && this._cache && now - this._cachedAt < CACHE_TTL_MS) return this._cache.slice();
    if (this._inflight) return this._inflight;
    this._inflight = this._load().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _load() {
    if (!this.scriptPath && !this.init()) {
      this._lastError = 'catalog script unavailable';
      return this._cache ? this._cache.slice() : [];
    }
    try {
      const out = await ps.runScriptJson(this.scriptPath, [], { timeoutMs: 30000 });
      if (!out || out.error) throw new Error((out && out.error) || 'catalog script returned error');
      const apps = Array.isArray(out.apps) ? out.apps.filter((a) => a && a.exePath) : [];
      this._cache = apps;
      this._cachedAt = Date.now();
      this._meta = { counts: out.counts || null, ms: out.ms || null, loadedAt: this._cachedAt, total: apps.length };
      this._lastError = null;
      this.log('catalog loaded: ' + apps.length + ' apps in ' + (out.ms || '?') + 'ms');
      return apps.slice();
    } catch (e) {
      this._lastError = e;
      this.log('catalog load failed: ' + e.message);
      return this._cache ? this._cache.slice() : [];
    }
  }

  invalidate() { this._cache = null; this._cachedAt = 0; }
  getLastError() { return this._lastError ? String(this._lastError.message || this._lastError) : null; }
  getMeta() { return this._meta; }
}

module.exports = { Catalog };