'use strict';
/**
 * prefs.js — reads/writes HKCU\Software\Microsoft\DirectX\UserGpuPreferences
 *             (the same store as Windows Settings > Display > Graphics).
 *
 * Value name : full exe path (as Windows wrote it, case-insensitive by registry semantics)
 * Value data : semicolon separated tokens, e.g. "GpuPreference=1;AppStatus=0;"
 *              GpuPreference: 0 = system default, 1 = power saving (iGPU), 2 = high performance (dGPU)
 *              Tokens we do not understand (AppStatus=0; ...) are preserved verbatim and in order.
 *
 * All access goes through powershell.exe (ps/prefs.ps1) because Node has no registry API and
 * reg.exe output is codepage-ambiguous. Reads are cached: they are served synchronously from the
 * cache, writes are rare (one PowerShell round-trip, ~250-350 ms) and are verified by read-back.
 */
const path = require('path');
const ps = require('./ps');

const SCRIPT_NAME = 'prefs.ps1';
const PREF_TOKEN = /^gpupreference\s*=\s*([012])\s*$/i;

class Prefs {
  constructor(opts) {
    const o = opts || {};
    this.dataDir = o.dataDir;
    this.logger = o.logger || null;
    this.scriptPath = null;
    /** @type {Map<string, {path:string, pref:number|null, raw:string, tokens:string[]}>} */
    this._cache = new Map();
    this._lastRefreshAt = 0;
    this._lastError = null;
    this._backups = new Map(); // lower path -> raw value before our first write (in memory)
  }

  log(msg) {
    if (this.logger && typeof this.logger === 'function') {
      try { this.logger('[bridge:prefs] ' + msg); } catch (_) { /* ignore */ }
    }
  }

  async init() {
    try {
      this.scriptPath = ps.materializeScript(SCRIPT_NAME, this.dataDir);
    } catch (e) {
      this._lastError = e;
      this.log('cannot materialise prefs.ps1: ' + e.message);
      return false;
    }
    await this.refresh();
    return true;
  }

  /** Parse a raw value into { pref, tokens }. */
  static parseRaw(raw) {
    const text = typeof raw === 'string' ? raw : '';
    const parts = text.split(';');
    const tokens = [];
    let pref = null;
    for (const part of parts) {
      const token = part.trim();
      if (!token) continue;
      tokens.push(token);
      const m = PREF_TOKEN.exec(token);
      if (m) pref = parseInt(m[1], 10);
    }
    return { pref, tokens, raw: text };
  }

  /** Build a raw value from tokens, replacing/inserting GpuPreference. */
  static composeRaw(tokens, pref) {
    const out = [];
    let replaced = false;
    for (const token of tokens) {
      if (PREF_TOKEN.test(token)) {
        if (!replaced) {
          out.push('GpuPreference=' + pref + ';');
          replaced = true;
        }
        // drop duplicate GpuPreference tokens, if any
      } else {
        out.push(token.endsWith(';') ? token : token + ';');
      }
    }
    if (!replaced) out.push('GpuPreference=' + pref + ';');
    return out.join('');
  }

  _put(pathKey, rawValue) {
    const parsed = Prefs.parseRaw(rawValue);
    this._cache.set(pathKey, {
      path: pathKey,
      pref: parsed.pref,
      raw: parsed.raw,
      tokens: parsed.tokens,
    });
  }

  /** Re-read every value under the key. Safe to call any time. */
  async refresh() {
    if (!this.scriptPath) return false;
    try {
      const out = await ps.runScriptJson(this.scriptPath, ['-Action', 'read'], { timeoutMs: 15000 });
      if (!out || out.error) throw new Error(out && out.error ? out.error : 'empty registry read');
      const values = out.values || {};
      const next = new Map();
      for (const name of Object.keys(values)) {
        const parsed = Prefs.parseRaw(values[name]);
        next.set(String(name).toLowerCase(), {
          path: String(name),
          pref: parsed.pref,
          raw: parsed.raw,
          tokens: parsed.tokens,
        });
      }
      this._cache = next;
      this._lastRefreshAt = Date.now();
      this._lastError = null;
      return true;
    } catch (e) {
      this._lastError = e;
      this.log('registry read failed: ' + e.message);
      return false;
    }
  }

  /** Synchronous lookup from cache: 0 | 1 | 2 | null (not set / no GpuPreference token). */
  getPreference(exePath) {
    if (!exePath) return null;
    const hit = this._cache.get(String(exePath).toLowerCase());
    return hit ? hit.pref : null;
  }

  /** Raw value currently known for a path (for diagnostics/UI). */
  getRaw(exePath) {
    if (!exePath) return null;
    const hit = this._cache.get(String(exePath).toLowerCase());
    return hit ? hit.raw : null;
  }

  get entries() {
    return Array.from(this._cache.values());
  }

  getLastError() { return this._lastError ? String(this._lastError.message || this._lastError) : null; }
  getLastRefreshAt() { return this._lastRefreshAt; }

  async _call(action, args) {
    if (!this.scriptPath) {
      this.scriptPath = ps.materializeScript(SCRIPT_NAME, this.dataDir);
    }
    return ps.runScriptJson(this.scriptPath, ['-Action', action].concat(args || []), { timeoutMs: 20000 });
  }

  async _readOne(exePath) {
    const out = await this._call('readone', ['-Path', exePath]);
    if (!out || out.error) throw new Error(out && out.error ? out.error : 'readone failed');
    return out;
  }

  /**
   * Write a preference. Returns evidence of before/after so the caller can persist it.
   * @param {string} exePath full exe path (used verbatim as the registry value name)
   * @param {0|1|2} pref
   */
  async setPreference(exePath, pref) {
    if (!exePath || typeof exePath !== 'string') throw new TypeError('setPreference: exePath required');
    const value = Number(pref);
    if (!(value === 0 || value === 1 || value === 2)) throw new TypeError('setPreference: pref must be 0, 1 or 2');
    const key = exePath.toLowerCase();
    if (!this._backups.has(key)) {
      const current = await this._readOne(exePath);
      this._backups.set(key, { raw: current.raw || '', existed: !!current.exists });
    }
    const current = await this._readOne(exePath);
    const parsed = Prefs.parseRaw(current.raw || '');
    const nextRaw = Prefs.composeRaw(parsed.tokens, value);
    const out = await this._call('set', ['-Path', exePath, '-Value', nextRaw]);
    if (!out || out.error || !out.ok) throw new Error((out && out.error) || 'registry write failed');
    const after = Prefs.parseRaw(out.raw);
    this._cache.set(key, { path: exePath, pref: after.pref, raw: after.raw, tokens: after.tokens });
    return {
      ok: true,
      exePath,
      pref: value,
      before: { existed: !!current.exists, raw: current.raw || '', pref: parsed.pref },
      after: { raw: out.raw, pref: after.pref },
      at: Date.now(),
    };
  }

  /** Delete the GpuPreference token (keeps AppStatus etc. and every other registry value). */
  async restoreDefault(exePath) {
    if (!exePath || typeof exePath !== 'string') throw new TypeError('restoreDefault: exePath required');
    const key = exePath.toLowerCase();
    const current = await this._readOne(exePath);
    const parsed = Prefs.parseRaw(current.raw || '');
    if (!current.exists) {
      this._cache.delete(key);
      return { ok: true, exePath, before: { existed: false, raw: '', pref: null }, removed: false, keptRaw: '' };
    }
    const remaining = parsed.tokens.filter((t) => !PREF_TOKEN.test(t));
    if (remaining.length === 0) {
      const out = await this._call('remove', ['-Path', exePath]);
      if (!out || out.error) throw new Error((out && out.error) || 'registry delete failed');
      this._cache.delete(key);
      return { ok: true, exePath, before: { existed: true, raw: current.raw, pref: parsed.pref }, removed: true, keptRaw: '' };
    }
    const kept = remaining.map((t) => (t.endsWith(';') ? t : t + ';')).join('');
    const out = await this._call('set', ['-Path', exePath, '-Value', kept]);
    if (!out || out.error || !out.ok) throw new Error((out && out.error) || 'registry write failed');
    const after = Prefs.parseRaw(out.raw);
    this._cache.set(key, { path: exePath, pref: after.pref, raw: after.raw, tokens: after.tokens });
    return { ok: true, exePath, before: { existed: true, raw: current.raw, pref: parsed.pref }, removed: false, keptRaw: kept };
  }

  /** Restore a raw value captured earlier (used by tests / undo). */
  async restoreRaw(exePath, raw, existed) {
    if (!existed) {
      const out = await this._call('remove', ['-Path', exePath]);
      if (out && out.error) throw new Error(out.error);
      this._cache.delete(exePath.toLowerCase());
      return true;
    }
    const out = await this._call('set', ['-Path', exePath, '-Value', raw || '']);
    if (!out || out.error || !out.ok) throw new Error((out && out.error) || 'restore failed');
    this._put(exePath.toLowerCase(), out.raw);
    return true;
  }

  getBackup(exePath) {
    return this._backups.get(String(exePath).toLowerCase()) || null;
  }
}

module.exports = { Prefs };