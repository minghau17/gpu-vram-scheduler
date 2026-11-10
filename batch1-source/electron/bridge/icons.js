'use strict';
/**
 * icons.js — exe 图标抽取 + 缓存。
 *
 *   - 图标存 <dataDir>/icons/<sha1(小写 exe 全路径)>.png，96×96 带 alpha（shell jumbo 256px 缩放，
 *     失败时退回 32px 缩放）。
 *   - 抽取在 PowerShell 里批量做：所有待抽路径攒 50ms 合成一个 job 文件，一次 powershell 调用
 *     处理最多 60 个（实测每个 4~20ms），避免 UI 加载时 30 次进程启动。
 *   - 失败/不存在的 exe 记 5 分钟负缓存，避免反复重试。
 *   - 对 UI 暴露：getIcon() 返回 PNG 绝对路径或 null；getIconUrl() 返回 file:/// URL
 *     （用 Node 的 pathToFileURL 生成，中文/空格正确编码）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const ps = require('./ps');

const SCRIPT_NAME = 'icons.ps1';
const BATCH_DEBOUNCE_MS = 50;
const BATCH_MAX = 60;
const BATCH_TIMEOUT_MS = 20000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

class Icons {
  constructor(opts) {
    const o = opts || {};
    this.dataDir = o.dataDir;
    this.logger = o.logger || null;
    this.scriptPath = null;
    this.iconDir = path.join(o.dataDir || '.', 'icons');
    this.jobDir = path.join(o.dataDir || '.', 'ps', 'jobs');
    this._configured = false;
    this._pending = new Map();   // lower path -> { exePath, out, resolvers: [] }
    this._negative = new Map();  // lower path -> ts
    this._running = false;
    this._timer = null;
    this._stats = { extracted: 0, failed: 0, batches: 0 };
  }

  log(msg) {
    if (this.logger && typeof this.logger === 'function') {
      try { this.logger('[bridge:icons] ' + msg); } catch (_) { /* ignore */ }
    }
  }

  init() {
    try {
      ps.ensureDir(this.iconDir);
      ps.ensureDir(this.jobDir);
      this.scriptPath = ps.materializeScript(SCRIPT_NAME, this.dataDir);
      this._configured = true;
      return true;
    } catch (e) {
      this.log('icon extractor unavailable: ' + e.message);
      this._configured = false;
      return false;
    }
  }

  _key(exePath) { return String(exePath || '').toLowerCase(); }

  _outPath(exePath) {
    return path.join(this.iconDir, sha1(this._key(exePath)) + '.png');
  }

  _isFile(p) {
    try { const st = fs.statSync(p); return st.isFile() && st.size > 64; } catch (_) { return false; }
  }

  /** Cached PNG path if present and fresh; null otherwise. Does not start extraction. */
  getCachedPath(exePath) {
    if (!exePath || !this._configured) return null;
    const out = this._outPath(exePath);
    if (!this._isFile(out)) return null;
    try {
      const exeStat = fs.statSync(exePath);
      const pngStat = fs.statSync(out);
      // exe 更新（升级）后图标可能变了：让 png 比 exe 新才行
      if (exeStat.mtimeMs > pngStat.mtimeMs + 2000) return null;
    } catch (_) { /* exe 不在了：仍返回旧的 png，UI 还能显示 */ }
    return out;
  }

  /** file:/// URL from cache, or null; schedules a background extraction when missing. */
  getCachedUrl(exePath) {
    const p = this.getCachedPath(exePath);
    if (p) {
      try { return pathToFileURL(p).href; } catch (_) { return null; }
    }
    if (exePath && this._configured) this.queue(exePath);
    return null;
  }

  /** SPEC bridge.getIcon(exePath): Promise<string|null> — PNG absolute path. */
  async getIcon(exePath) {
    if (!exePath || !this._configured) return null;
    const cached = this.getCachedPath(exePath);
    if (cached) return cached;
    const key = this._key(exePath);
    const negAt = this._negative.get(key);
    if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) return null;
    try {
      const st = fs.statSync(exePath);
      if (!st.isFile()) return null;
    } catch (_) {
      this._negative.set(key, Date.now());
      return null;
    }
    return this._enqueue(exePath);
  }

  /** Fire-and-forget warm-up (used for running apps so the first tick already has iconUrl). */
  queue(exePath) {
    if (!exePath || !this._configured) return;
    const key = this._key(exePath);
    const negAt = this._negative.get(key);
    if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) return;
    if (this._pending.has(key)) return;
    this._pending.set(key, { exePath, out: this._outPath(exePath), resolvers: [] });
    this._schedule();
  }

  async warm(list) {
    if (!Array.isArray(list) || !this._configured) return 0;
    const tasks = [];
    for (const exePath of list) {
      if (!exePath) continue;
      if (this.getCachedPath(exePath)) continue;
      tasks.push(this.getIcon(exePath).catch(() => null));
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  _enqueue(exePath) {
    const key = this._key(exePath);
    return new Promise((resolve) => {
      let entry = this._pending.get(key);
      if (!entry) {
        entry = { exePath, out: this._outPath(exePath), resolvers: [] };
        this._pending.set(key, entry);
      }
      const timer = setTimeout(() => {
        entry.resolvers = entry.resolvers.filter((r) => r !== finish);
      }, BATCH_TIMEOUT_MS + 5000);
      if (timer.unref) timer.unref();
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      entry.resolvers.push(finish);
      this._schedule();
    });
  }

  _schedule() {
    if (this._timer || this._running) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._run().catch((e) => this.log('batch run failed: ' + e.message));
    }, BATCH_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  async _run() {
    if (this._running) return;
    if (!this._configured || !this.scriptPath) {
      this._flushAll(null);
      return;
    }
    const batch = [];
    for (const entry of this._pending.values()) {
      if (batch.length >= BATCH_MAX) break;
      batch.push(entry);
    }
    if (batch.length === 0) return;
    for (const entry of batch) this._pending.delete(this._key(entry.exePath));
    this._running = true;
    this._stats.batches++;
    const jobFile = path.join(this.jobDir, 'icons-' + Date.now() + '-' + process.pid + '.json');
    try {
      const job = batch.map((e) => ({ path: e.exePath, out: e.out }));
      fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
      const result = await ps.runScriptJson(this.scriptPath, ['-JobFile', jobFile, '-OutDir', this.iconDir], { timeoutMs: BATCH_TIMEOUT_MS });
      const byPath = new Map();
      for (const r of (result && result.results) || []) {
        if (r && r.path) byPath.set(String(r.path).toLowerCase(), r);
      }
      for (const entry of batch) {
        const r = byPath.get(this._key(entry.exePath));
        const ok = r && r.ok && this._isFile(entry.out);
        if (ok) {
          this._stats.extracted++;
          this._negative.delete(this._key(entry.exePath));
          for (const resolve of entry.resolvers) resolve(entry.out);
        } else {
          this._stats.failed++;
          this._negative.set(this._key(entry.exePath), Date.now());
          if (r && r.error) this.log('icon failed for ' + path.basename(entry.exePath) + ': ' + r.error);
          for (const resolve of entry.resolvers) resolve(null);
        }
      }
    } catch (e) {
      this.log('icon batch error: ' + e.message);
      for (const entry of batch) {
        this._negative.set(this._key(entry.exePath), Date.now());
        for (const resolve of entry.resolvers) resolve(null);
      }
    } finally {
      this._running = false;
      try { if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile); } catch (_) { /* ignore */ }
      if (this._pending.size > 0) this._schedule();
    }
  }

  _flushAll(value) {
    for (const entry of this._pending.values()) {
      for (const resolve of entry.resolvers) resolve(value);
    }
    this._pending.clear();
  }

  /** Wait until the queue is empty (tests). */
  async idle() {
    while (this._running || this._pending.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  getStats() {
    return Object.assign({}, this._stats, { pending: this._pending.size, negative: this._negative.size, iconDir: this.iconDir });
  }

  invalidate(exePath) {
    const key = this._key(exePath);
    this._negative.delete(key);
    try { fs.unlinkSync(this._outPath(exePath)); } catch (_) { /* ignore */ }
  }
}

module.exports = { Icons, sha1 };