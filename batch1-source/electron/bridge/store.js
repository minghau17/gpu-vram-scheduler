'use strict';
/**
 * store.js — tiny atomic JSON store for <dataDir>/state.json.
 * Holds: settings, watchList, savings sessions.  Writes are atomic-ish (tmp + rename) and never throw
 * to the caller's polling loop.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  settings: {
    interval: 2000,
    autoStart: false,
    minimizeToTray: true,
    defaultPreference: 0,
    autoOptimize: false,
    dataDir: '',
  },
  watchList: [],
  savings: { totalFreedMB: 0, sessions: [] },
};

function deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this._state = deepClone(DEFAULTS);
  }

  load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (_) { /* ignore */ }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this._state = {
        version: 1,
        settings: Object.assign(deepClone(DEFAULTS.settings), parsed.settings || {}),
        watchList: Array.isArray(parsed.watchList) ? parsed.watchList : [],
        savings: parsed.savings && typeof parsed.savings === 'object'
          ? { totalFreedMB: Number(parsed.savings.totalFreedMB) || 0, sessions: Array.isArray(parsed.savings.sessions) ? parsed.savings.sessions : [] }
          : deepClone(DEFAULTS.savings),
      };
    } catch (_) {
      this._state = deepClone(DEFAULTS);
    }
    return this._state;
  }

  getState() { return this._state; }
  setState(next) { this._state = next; return this._state; }

  save() {
    const text = JSON.stringify(this._state, null, 2);
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      // rename can fail if another process (antivirus / previous instance) holds the file; fall back
      try { fs.writeFileSync(this.file, text, 'utf8'); return true; } catch (_) { return false; }
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { Store, DEFAULTS, deepClone };