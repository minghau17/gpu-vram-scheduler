'use strict';
/**
 * adapters.js — turns the raw counter sample + the adapter metadata reported by the PowerShell
 * worker (DXGI enumeration) into the SPEC `snapshot.adapters` array.
 *
 * LUID mapping (measured on this machine, see bridge/README.md):
 *   0x00000000_0x0001548b -> NVIDIA GeForce RTX 3060 Laptop GPU   (VEN_10DE&DEV_2520, dedicated 6 GB)
 *   0x00000000_0x0001504f -> Intel(R) UHD Graphics                (VEN_8086&DEV_9A60, dedicated 128 MB, shared 8 GB)
 *   0x00000000_0x000153f9 -> Microsoft Basic Render Driver        (software / WARP, flags=2)
 *   The MuMu virtual display adapter (ROOT\DISPLAY\0000) is a display-only IDD: it is NOT a DXGI
 *   adapter and has no GPU memory counters, so it never appears in the snapshot adapter list.
 *
 * The dGPU total comes from `nvidia-smi --query-gpu=memory.total` when available (that is the
 * number Task Manager shows, 6144 MiB here).  There is no "\GPU Adapter Memory\Dedicated Limit"
 * counter on this Windows build, so for the iGPU we use the DXGI SharedSystemMemory budget
 * (Windows' shared GPU memory cap, ~half of RAM) as totalMB — documented in the README.
 */
const { spawn } = require('child_process');
const path = require('path');

const MB = 1024 * 1024;
const NVIDIA_SMI = process.env.GPU_SCHEDULER_NVIDIA_SMI ||
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');

const VENDORS = {
  0x10de: 'nvidia',
  0x8086: 'intel',
  0x1002: 'amd',
  0x1022: 'amd',
};
// 0x1414 = Microsoft (Basic Render Driver / WARP) — software adapter, no VRAM.

function roundMB(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n / MB);
}

function vendorOf(vendorId) {
  const v = VENDORS[Number(vendorId)];
  return v || 'unknown';
}

/**
 * 供应商优先级（按本机实测写死，Lead 要求 UI 直接按 kind 上色）：
 *   NVIDIA                 -> dgpu (独显)
 *   Intel / AMD            -> igpu (集显/核显；AMD APU 也归这一类)
 *   Microsoft 0x1414 / WARP / DXGI_ADAPTER_FLAG_SOFTWARE -> virtual (虚拟/软件)
 *   MuMu 虚拟显示器是 IDD，不是 DXGI 适配器，不会出现在这里。
 *   其它厂商：dedicated > 1.5GB 视为 dgpu，否则 igpu。
 */
function kindOf(meta) {
  const vendor = vendorOf(meta.vendorId);
  const software = (Number(meta.flags) & 2) === 2;
  if (software) return 'virtual';
  if (vendor === 'nvidia') return 'dgpu';
  if (vendor === 'intel' || vendor === 'amd') return 'igpu';
  if (Number(meta.vendorId) === 0x1414) return 'virtual';
  if (Number(meta.dedicatedVideoBytes) >= 1.5 * 1024 * MB) return 'dgpu';
  return 'igpu';
}

/** Query nvidia-smi. Never throws; returns null when unavailable. */
function queryNvidiaSmi(timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    let child;
    try {
      child = spawn(NVIDIA_SMI, ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) { return resolve(null); }
    let out = '';
    let err = '';
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      finish(null);
    }, timeoutMs || 4000);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/)[0];
      if (!line) return finish(null);
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 3) return finish(null);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      if (!isFinite(total) || total <= 0) return finish(null);
      finish({ name: parts[0], totalMB: total, usedMB: isFinite(used) ? used : null });
    });
  });
}

/**
 * Build the adapter list.
 * @param {object} raw   raw sample from counters.js
 * @param {object} meta  counters.getMeta() -> { dxgiAdapters: [...] }
 * @param {object} nvsmi result of queryNvidiaSmi() (may be null)
 */
function buildAdapters(raw, meta, nvsmi) {
  const dxgi = (meta && Array.isArray(meta.dxgiAdapters)) ? meta.dxgiAdapters : [];
  const rawByLuid = new Map();
  for (const a of (raw && raw.adapters) || []) {
    if (a && a.luid) rawByLuid.set(String(a.luid).toLowerCase(), a);
  }

  const list = [];
  const seenLuid = new Set();
  const seenSignature = new Set();

  const push = (entry) => {
    if (!entry || !entry.luid || seenLuid.has(entry.luid)) return;
    const sig = entry.kind + '|' + entry.vendor + '|' + entry.name;
    // DXGI can enumerate the same physical iGPU twice (e.g. Intel 0x1504f + 0x1f6f2).  Keep the
    // one that actually has counters; drop the phantom duplicate when both are present.
    const hasCounters = rawByLuid.has(entry.luid);
    if (!hasCounters && seenSignature.has(sig)) return;
    seenLuid.add(entry.luid);
    seenSignature.add(sig);
    list.push(entry);
  };

  for (const d of dxgi) {
    const luid = String(d.luid || '').toLowerCase();
    if (!luid) continue;
    const kind = kindOf(d);
    const ctr = rawByLuid.get(luid) || {};
    const vendor = vendorOf(d.vendorId);
    let totalMB = 0;
    let source = 'counter';
    if (kind === 'dgpu') {
      const dedMB = roundMB(d.dedicatedVideoBytes);
      if (nvsmi && nvsmi.totalMB > 0 && (vendor === 'nvidia' || !/intel|amd/i.test(d.name || ''))) {
        totalMB = nvsmi.totalMB;
        source = 'nvidia-smi';
      } else {
        totalMB = dedMB;
      }
    } else if (kind === 'igpu') {
      totalMB = roundMB(d.sharedSystemBytes) || roundMB(d.dedicatedVideoBytes);
    } else {
      totalMB = roundMB(d.dedicatedVideoBytes);
    }
    const dedMB = roundMB(ctr.dedBytes);
    const sharedMB = roundMB(ctr.sharedBytes);
    const usedMB = kind === 'dgpu'
      ? (dedMB || (nvsmi && nvsmi.usedMB) || 0)
      : (dedMB + sharedMB);
    push({
      luid,
      name: d.name || (kind === 'dgpu' ? '独立显卡' : kind === 'igpu' ? '核芯显卡' : '虚拟显示适配器'),
      vendor,
      kind,
      totalMB,
      usedMB,
      sharedUsedMB: sharedMB,
      dedicatedUsedMB: dedMB,
      source,
      // extra evidence, not required by the contract but handy in the UI / tests
      dedicatedVideoMB: roundMB(d.dedicatedVideoBytes),
      sharedSystemMB: roundMB(d.sharedSystemBytes),
      software: (Number(d.flags) & 2) === 2,
    });
  }

  // Fallback when DXGI metadata is unavailable: derive roles from the counters themselves.
  if (list.length === 0) {
    const entries = Array.from(rawByLuid.values());
    const dgpuCandidate = entries.slice().sort((a, b) => (b.dedBytes || 0) - (a.dedBytes || 0))[0];
    for (const ctr of entries) {
      const luid = String(ctr.luid).toLowerCase();
      const dedMB = roundMB(ctr.dedBytes);
      const sharedMB = roundMB(ctr.sharedBytes);
      const isVirtual = luid === '0x00000000_0x000153f9';
      let kind = 'igpu';
      if (isVirtual) kind = 'virtual';
      else if (ctr === dgpuCandidate && dedMB > 0) kind = 'dgpu';
      const summary = {
        luid,
        name: kind === 'dgpu' ? ((nvsmi && nvsmi.name) || '独立显卡')
          : kind === 'igpu' ? '核芯显卡' : '虚拟显示适配器',
        vendor: kind === 'dgpu' ? 'nvidia' : 'unknown',
        kind,
        totalMB: kind === 'dgpu' ? ((nvsmi && nvsmi.totalMB) || dedMB) : 0,
        usedMB: kind === 'dgpu' ? dedMB : dedMB + sharedMB,
        sharedUsedMB: sharedMB,
        dedicatedUsedMB: dedMB,
        source: kind === 'dgpu' && nvsmi ? 'nvidia-smi' : 'counter',
        degraded: true,
      };
      push(summary);
    }
  }

  const order = { dgpu: 0, igpu: 1, virtual: 2 };
  list.sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9) || a.luid.localeCompare(b.luid));
  return list;
}

function findAdapter(adapters, kind) {
  for (const a of adapters) if (a.kind === kind) return a;
  return null;
}

module.exports = { buildAdapters, queryNvidiaSmi, findAdapter, roundMB, kindOf, vendorOf };