'use strict';
/**
 * counters.js — GPU counter collector.
 *
 * Strategy (measured on this machine):
 *   A single resident `powershell.exe` runs bridge/ps/gpu-sampler.ps1.  The script compiles a small
 *   C# helper once (PDH P/Invoke + DXGI adapter enumeration) and then blocks reading stdin.  The
 *   Node side writes "tick\n" whenever it wants a sample and the worker answers with exactly one
 *   single-line JSON document.  Measured cost: 19-45 ms per sample (well under the 400 ms budget),
 *   worker startup + handshake ~0.7-1.0 s once.
 *
 *   Driving the cadence from stdin (instead of a sleep loop inside PowerShell) buys us:
 *     - collectOnce() can return immediately instead of waiting for the next 2 s slot,
 *     - no drift / no double sampling,
 *     - when the Electron main process dies the pipe closes and the worker exits by itself
 *       (ReadLine returns null) — no orphan powershell.exe processes.
 *
 *   Fallback: if the resident worker cannot be started or keeps failing, we degrade to spawning a
 *   fresh `powershell -File gpu-sampler.ps1 -Once` per sample with a hard timeout (and one retry).
 *
 * Sample JSON produced by the worker (bytes, raw):
 *   { v:1, ts, ms, adapters:[{luid,dedBytes,sharedBytes,committedBytes,localBytes,nonLocalBytes}],
 *     processes:[[pid,luid,ded,shared,nonLocal,local,committed],...],
 *     engines:[[pid,luid,engtype,utilPct],...],
 *     procs:[[pid,path,processName,fileDescription,hasWindow],...] }
 */
const { spawn } = require('child_process');
const ps = require('./ps');

const SCRIPT_NAME = 'gpu-sampler.ps1';
const HELLO_TIMEOUT_MS = 20000;
const TICK_TIMEOUT_MS = 4000;
const ONCE_TIMEOUT_MS = 8000;
const MAX_TICK_FAILURES = 2;

class CounterCollector {
  constructor(opts) {
    const o = opts || {};
    this.dataDir = o.dataDir;
    this.logger = o.logger || null;
    this.scriptPath = null;
    this.child = null;
    this.reader = null;
    this.meta = {
      dxgiAdapters: [],
      displayPaths: [],
      counters: [],
      workerVersion: null,
      psPid: null,
      degraded: false,
      lastError: null,
    };
    this.mode = 'none'; // 'resident' | 'spawn' | 'none'
    this._stopRequested = false;
    this._tickFailures = 0;
    this._inflight = null;
    this._stderr = '';
    this._startedAt = 0;
    this._lastSampleMs = null;
    this._lastSampleAt = 0;
    this._onExit = this._handleChildExit.bind(this);
  }

  log(msg) {
    if (this.logger && typeof this.logger === 'function') {
      try { this.logger('[bridge:counters] ' + msg); } catch (_) { /* ignore */ }
    }
  }

  /** Prepare the worker script and start the resident process. Never throws. */
  async init() {
    if (!ps.isWindows()) {
      this.meta.lastError = 'not running on Windows';
      this.mode = 'spawn';
      return false;
    }
    try {
      this.scriptPath = ps.materializeScript(SCRIPT_NAME, this.dataDir);
    } catch (e) {
      this.meta.lastError = e;
      this.mode = 'spawn';
      this.log('cannot materialise script: ' + e.message);
      return false;
    }
    try {
      await this._spawnResident();
      return true;
    } catch (e) {
      this.meta.lastError = e;
      this.mode = 'spawn';
      this.log('resident worker unavailable, using per-sample spawn fallback: ' + e.message);
      return false;
    }
  }

  _attachStderr(child) {
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      this._stderr = (this._stderr + text).slice(-8192);
      if (/error|错误|exception/i.test(text)) this.log('worker stderr: ' + text.trim().slice(0, 500));
    });
  }

  async _spawnResident() {
    this._killChild();
    this._stopRequested = false;
    this._stderr = '';
    const child = spawn(ps.PS_EXE, ps.psArgs(this.scriptPath, []), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.reader = ps.createLineReader(child.stdout);
    this._attachStderr(child);
    child.on('exit', this._onExit);
    child.on('error', (err) => {
      this.meta.lastError = err;
      this.log('worker spawn error: ' + err.message);
    });

    const helloLine = await this.reader.nextLine(HELLO_TIMEOUT_MS);
    let hello;
    try { hello = JSON.parse(helloLine); } catch (e) {
      throw new Error('bad worker handshake: ' + helloLine.slice(0, 300));
    }
    if (!hello || hello.type !== 'hello') throw new Error('unexpected worker handshake: ' + String(helloLine).slice(0, 200));
    if (!hello.ok) throw new Error('worker init failed: ' + (hello.initError || 'unknown'));

    const parse = (text, fallback) => {
      if (!text) return fallback;
      try { return JSON.parse(text); } catch (_) { return fallback; }
    };
    this.meta.dxgiAdapters = parse(hello.dxgiAdaptersJson, []);
    this.meta.displayPaths = parse(hello.displayPathsJson, []);
    this.meta.counters = Array.isArray(hello.counters) ? hello.counters : [];
    this.meta.workerVersion = hello.version || null;
    this.meta.psPid = hello.psPid || null;
    this.meta.degraded = false;
    this.meta.lastError = null;
    this.mode = 'resident';
    this._tickFailures = 0;
    this._startedAt = Date.now();
    this.log('resident worker ready (psPid=' + hello.psPid + ', counters=' +
      this.meta.counters.length + ', dxgiAdapters=' + this.meta.dxgiAdapters.length + ')');
    return hello;
  }

  _handleChildExit(code, signal) {
    const wasResident = this.mode === 'resident';
    this.child = null;
    this.reader = null;
    if (this.mode === 'resident') this.mode = 'spawn';
    if (this._stopRequested) return;
    this.meta.degraded = true;
    this.meta.lastError = 'worker exited (code=' + code + ', signal=' + signal + ')';
    if (wasResident) this.log('resident worker exited unexpectedly (code=' + code + '); will respawn on next sample');
  }

  _killChild() {
    const child = this.child;
    this.child = null;
    this.reader = null;
    this.mode = 'none';
    if (!child) return;
    try { child.removeListener('exit', this._onExit); } catch (_) { /* ignore */ }
    try { child.stdin.write('q\n'); } catch (_) { /* ignore */ }
    try { child.stdin.end(); } catch (_) { /* ignore */ }
    try { child.kill(); } catch (_) { /* ignore */ }
  }

  /**
   * Collect one raw sample. Deduplicates concurrent calls (anti re-entrancy).
   * @returns {Promise<object>} raw sample
   */
  collect() {
    if (this._inflight) return this._inflight;
    const p = this._doCollect().finally(() => { this._inflight = null; });
    this._inflight = p;
    return p;
  }

  async _doCollect() {
    // resident path (with one respawn attempt)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.mode !== 'resident' || !this.child || !this.reader) {
        try { await this._spawnResident(); } catch (e) {
          this.meta.lastError = e;
          this.log('worker (re)start failed: ' + e.message);
          break; // fall through to one-shot spawn
        }
      }
      try {
        const sample = await this._tick();
        this._tickFailures = 0;
        this._lastSampleMs = sample.ms != null ? sample.ms : null;
        this._lastSampleAt = Date.now();
        return sample;
      } catch (e) {
        this._tickFailures++;
        this.meta.lastError = e;
        this.log('tick failed (' + attempt + '): ' + e.message);
        this._killChild();
        if (this._tickFailures >= MAX_TICK_FAILURES) break;
      }
    }
    // degraded one-shot path
    return this._collectBySpawn();
  }

  async _tick() {
    const child = this.child;
    if (!child) throw new Error('no worker');
    child.stdin.write('tick\n');
    const line = await this.reader.nextLine(TICK_TIMEOUT_MS);
    let sample;
    try { sample = JSON.parse(line); } catch (e) {
      throw new Error('bad sample JSON: ' + String(line).slice(0, 200));
    }
    if (!sample || !Array.isArray(sample.adapters)) {
      throw new Error('sample missing adapters: ' + String(line).slice(0, 200));
    }
    return sample;
  }

  async _collectBySpawn() {
    this.mode = 'spawn';
    const scriptPath = this.scriptPath || ps.materializeScript(SCRIPT_NAME, this.dataDir);
    const runOnce = async () => {
      const res = await ps.runScript(scriptPath, ['-Once'], { timeoutMs: ONCE_TIMEOUT_MS });
      // line 1 = handshake, line 2 = sample; take the last parsable JSON with adapters
      const lines = res.lines.filter((l) => l && l[0] === '{');
      let hello = null;
      let sample = null;
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj && obj.type === 'hello') hello = obj;
        else if (obj && Array.isArray(obj.adapters)) sample = obj;
      }
      if (hello) {
        const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } };
        this.meta.dxgiAdapters = parse(hello.dxgiAdaptersJson, this.meta.dxgiAdapters);
        this.meta.displayPaths = parse(hello.displayPathsJson, this.meta.displayPaths);
        this.meta.counters = Array.isArray(hello.counters) ? hello.counters : this.meta.counters;
        this.meta.workerVersion = hello.version || this.meta.workerVersion;
      }
      if (!sample) throw new Error('one-shot sampler produced no sample (exit=' + res.code + ')');
      this._lastSampleMs = sample.ms != null ? sample.ms : null;
      this._lastSampleAt = Date.now();
      this.meta.degraded = true;
      return sample;
    };
    try {
      return await runOnce();
    } catch (e) {
      this.log('one-shot sample failed, retrying once: ' + e.message);
      return runOnce();
    }
  }

  stop() {
    this._stopRequested = true;
    this._killChild();
    this.mode = 'none';
  }

  getMeta() {
    return {
      dxgiAdapters: this.meta.dxgiAdapters,
      displayPaths: this.meta.displayPaths,
      counters: this.meta.counters,
      workerVersion: this.meta.workerVersion,
      psPid: this.meta.psPid,
      degraded: this.meta.degraded,
      mode: this.mode,
      lastError: this.meta.lastError ? String(this.meta.lastError.message || this.meta.lastError) : null,
      lastSampleMs: this._lastSampleMs,
      lastSampleAt: this._lastSampleAt,
      startedAt: this._startedAt,
    };
  }
}

module.exports = { CounterCollector };