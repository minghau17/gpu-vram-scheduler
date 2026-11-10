'use strict';
/**
 * ps.js — PowerShell plumbing shared by the bridge modules.
 *
 * Why this exists:
 *  - The machine has Windows PowerShell 5.1 only.  It reads .ps1 files as ANSI/GBK unless the
 *    file starts with a UTF-8 BOM, so every script we materialise is written with a BOM.
 *  - Scripts live next to the JS (bridge/ps/*.ps1) at build time, but in a packaged Electron app
 *    that directory sits inside an asar archive which PowerShell cannot execute.  At init we copy
 *    each script into <dataDir>\ps\ (BOM added) and execute that copy.
 *  - stdout is decoded with StringDecoder so multi-byte characters (Chinese exe names/paths) are
 *    never torn across chunk boundaries.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const PS_EXE = process.env.GPU_SCHEDULER_PS_EXE ||
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const SRC_DIR = path.join(__dirname, 'ps');
const BOM = '\uFEFF';

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
}

/** Copy bridge/ps/<name> to <dataDir>/ps/<name> with a UTF-8 BOM. Returns the executable path. */
function materializeScript(name, dataDir) {
  const targetDir = ensureDir(path.join(dataDir, 'ps'));
  const src = path.join(SRC_DIR, name);
  const dst = path.join(targetDir, name);
  let body;
  try { body = fs.readFileSync(src, 'utf8'); } catch (e) {
    throw new Error('missing PowerShell script ' + src + ': ' + e.message);
  }
  const text = body.charAt(0) === BOM ? body : BOM + body;
  let existing = null;
  try { existing = fs.readFileSync(dst, 'utf8'); } catch (_) { /* not there yet */ }
  if (existing !== text) fs.writeFileSync(dst, text, 'utf8');
  return dst;
}

function psArgs(scriptPath, extra) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  if (Array.isArray(extra)) args.push.apply(args, extra);
  return args;
}

/** Line-oriented reader over a stream with UTF-8 safe decoding. */
function createLineReader(stream) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const queue = [];
  const waiters = [];
  let closed = false;
  let closedError = null;

  function drain() {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (waiters.length) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.resolve(line);
      } else {
        queue.push(line);
      }
    }
  }

  stream.on('data', (chunk) => {
    buf += decoder.write(chunk);
    drain();
  });
  stream.on('end', () => {
    buf += decoder.end();
    drain();
    closed = true;
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(closedError || new Error('stream closed'));
    }
  });
  stream.on('error', (err) => {
    closedError = err;
    closed = true;
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(err);
    }
  });

  function failAll(err) {
    closedError = closedError || err;
    closed = true;
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(closedError);
    }
  }

  function nextLine(timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(closedError || new Error('stream closed'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timeout waiting for PowerShell output (' + timeoutMs + 'ms)'));
        }, timeoutMs);
        if (waiter.timer.unref) waiter.timer.unref();
      }
      waiters.push(waiter);
    });
  }

  return { nextLine, failAll, pending: () => queue.length, isClosed: () => closed };
}

/**
 * Spawn a PowerShell one-shot script, collect its stdout lines.
 * @returns {Promise<{code:number|null, lines:string[], stderr:string}>}
 */
function runScript(scriptPath, args, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PS_EXE, psArgs(scriptPath, args), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return reject(e); }

    const reader = createLineReader(child.stdout);
    const lines = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
      reject(new Error('PowerShell script timed out after ' + timeoutMs + 'ms: ' + path.basename(scriptPath)));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    (async () => {
      try {
        // Drain until EOF; keep every line (scripts are tiny).
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const line = await reader.nextLine(0);
          if (line.length) lines.push(line);
        }
      } catch (_) { /* EOF is the normal exit */ }
    })();

    child.stderr.on('data', (d) => {
      if (stderr.length < 8192) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, lines, stderr });
    });
  });
}

/** Run a script that prints one JSON document, parse the last JSON-looking line. */
async function runScriptJson(scriptPath, args, opts) {
  const res = await runScript(scriptPath, args, opts);
  for (let i = res.lines.length - 1; i >= 0; i--) {
    const line = res.lines[i].trim();
    if (!line || (line[0] !== '{' && line[0] !== '[')) continue;
    try { return JSON.parse(line); } catch (_) { /* keep looking */ }
  }
  const detail = res.stderr ? res.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') : '';
  throw new Error('no JSON output from ' + path.basename(scriptPath) +
    ' (exit=' + res.code + ')' + (detail ? ': ' + detail : ''));
}

function isWindows() { return process.platform === 'win32'; }

module.exports = {
  PS_EXE,
  BOM,
  ensureDir,
  materializeScript,
  psArgs,
  createLineReader,
  runScript,
  runScriptJson,
  isWindows,
};