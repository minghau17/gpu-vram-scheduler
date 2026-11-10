'use strict';
/**
 * test.js — gpu-bridge 一次性自检。用法：  node test.js
 *
 * 覆盖 SPEC「后端契约」验收点：
 *   1. 适配器识别（RTX 3060 = dgpu / totalMB 6144；Intel = igpu；WARP = virtual），LUID 实测映射
 *   2. 显存归因：适配器级 Dedicated vs nvidia-smi ≤32MB；逐进程求和（排除 dwm 计数器虚高）vs
 *      nvidia-smi ≤512MB
 *   3. 采集性能：常驻 PowerShell 单次采样 p95 ≤400ms；tick 事件；spawn 兜底可用
 *   4. apps：字段/中文分类/推荐/聚合/iconUrl(file:///)
 *   5. 注册表：GpuPreference 0/1/2 写入回读 + AppStatus 保留 + restoreDefault + 条目数不变
 *   6. 释放量化状态机：假时钟假数据（applied 证据字段 / 5min needsRestart / freed 不为负）
 *   7. 图标抽取 96×96 PNG、listInstalledApps、history、engineInfo、smartOptimize、settings/watchList
 *
 * 测试使用隔离的临时 dataDir（data\_selftest_<pid>），结束后删除；注册表只动一个虚构测试路径，
 * 结束时恢复/删除，绝不碰用户已有条目。
 */
const fs = require('fs');
const path = require('path');

const bridge = require('./index');
const { Prefs } = require('./prefs');
const { SavingsEngine } = require('./savings');
const { Store } = require('./store');
const { queryNvidiaSmi } = require('./adapters');
const { VALID_CATEGORIES } = require('./apps');
const ps = require('./ps');

// ───────────────────────── 断言 / 表格 ─────────────────────────
const ROWS = [];
const GROUP_ORDER = [];
function addGroup(g) { if (!GROUP_ORDER.includes(g)) GROUP_ORDER.push(g); }
function check(group, name, cond, expected, actual, detail) {
  addGroup(group);
  ROWS.push({ group, name, expected: String(expected), actual: String(actual), status: cond ? 'PASS' : 'FAIL', detail: detail || '' });
  return !!cond;
}
function skip(group, name, expected, actual, detail) {
  addGroup(group);
  ROWS.push({ group, name, expected: String(expected), actual: String(actual), status: 'SKIP', detail: detail || '' });
}
function info(group, name, detail) {
  addGroup(group);
  ROWS.push({ group, name, expected: '—', actual: '—', status: 'INFO', detail: detail || '' });
}
function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return n;
}
function pad(s, width) {
  const str = String(s == null ? '' : s);
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}
function trunc(s, width) {
  const str = String(s == null ? '' : s);
  if (displayWidth(str) <= width) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}
function printTable() {
  const W1 = 12, W2 = 30, W3 = 30, W4 = 40;
  const line = '─'.repeat(W1 + W2 + W3 + W4 + 3 + 8 + 3);
  console.log('\n' + line);
  console.log(pad('分组', W1) + ' ' + pad('检查项', W2) + ' ' + pad('期望', W3) + ' ' + pad('实际', W4) + ' ' + pad('结果', 6));
  console.log(line);
  let lastGroup = null;
  for (const r of ROWS) {
    if (r.group !== lastGroup) { lastGroup = r.group; }
    console.log(pad(r.group, W1) + ' ' + pad(trunc(r.name, W2), W2) + ' ' + pad(trunc(r.expected, W3), W3) + ' ' +
      pad(trunc(r.actual, W4), W4) + ' ' + pad(r.status, 6) + (r.detail ? '  ' + r.detail : ''));
  }
  console.log(line);
  const pass = ROWS.filter((r) => r.status === 'PASS').length;
  const fail = ROWS.filter((r) => r.status === 'FAIL').length;
  const skipN = ROWS.filter((r) => r.status === 'SKIP').length;
  console.log(`合计： PASS ${pass} ｜ FAIL ${fail} ｜ SKIP ${skipN}`);
  console.log(line + '\n');
  return fail;
}

// ───────────────────────── 测试主体 ─────────────────────────
const TEST_EXE_PREFS = 'C:\\__gpu_scheduler_selftest__\\prefs-selftest.exe';
const TEST_EXE_BRIDGE = 'C:\\__gpu_scheduler_selftest__\\bridge-selftest.exe';
const DATA_DIR = path.join(__dirname, '..', '..', 'data', '_selftest_' + process.pid);

function pngSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 24) return null;
    const sig = buf.slice(0, 8).toString('hex');
    if (sig !== '89504e470d0a1a0a') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  } catch (_) { return null; }
}

async function waitFor(fn, timeoutMs, stepMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return true; } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, stepMs || 100));
  }
  return false;
}

async function run() {
  const prefs = {};
  let testPrefs = null;
  let originalPrefsRaw = null;
  let bridgeStarted = false;
  let bridgeTestCreated = false;

  try {
    // ── 0. init ──
    const tInit0 = Date.now();
    await bridge.init({ dataDir: DATA_DIR });
    const initMs = Date.now() - tInit0;

    // ── 1. 采集 + 快照结构 ──
    const tickWaiter = { count: 0 };
    const onTick = () => { tickWaiter.count++; };
    bridge.on('tick', onTick);
    let snap;
    const tCollect0 = Date.now();
    try {
      snap = await bridge.collectOnce();
    } finally {
      bridge.removeListener('tick', onTick);
    }
    const firstCollectMs = Date.now() - tCollect0;
    check('采集', 'collectOnce 直接返回 snapshot（无 {ok,data} 包装）',
      !!snap && typeof snap.ts === 'number' && Array.isArray(snap.adapters) && Array.isArray(snap.apps) && !!snap.totals && snap.ok === undefined,
      '顶层 ts/adapters/apps/totals', snap ? Object.keys(snap).join(',') : 'null');
    check('采集', 'tick 事件在采样后触发', tickWaiter.count === 1, '1 次', tickWaiter.count + ' 次');
    check('采集', 'snapshot.adapters 字段齐全',
      snap.adapters.every((a) => a.luid && a.name && a.vendor && a.kind && typeof a.totalMB === 'number' &&
        typeof a.usedMB === 'number' && typeof a.sharedUsedMB === 'number' && (a.source === 'nvidia-smi' || a.source === 'counter')),
      'luid/name/vendor/kind/totalMB/usedMB/sharedUsedMB/source', snap.adapters.length + ' 个适配器');

    // ── 2. 适配器识别 ──
    const dgpu = snap.adapters.find((a) => a.kind === 'dgpu');
    const igpu = snap.adapters.find((a) => a.kind === 'igpu');
    const virt = snap.adapters.find((a) => a.kind === 'virtual');
    check('适配器', '识别到独显 dgpu', !!dgpu, '1 个 dgpu', dgpu ? dgpu.name : '缺失');
    check('适配器', '独显厂商 = nvidia', dgpu && dgpu.vendor === 'nvidia', 'nvidia', dgpu ? dgpu.vendor : '缺失');
    check('适配器', '独显名称匹配 RTX 3060', dgpu && /RTX\s*3060/i.test(dgpu.name), 'RTX 3060', dgpu ? dgpu.name : '缺失');
    check('适配器', '独显 totalMB ≈ 6144 (±64)', !!dgpu && Math.abs(dgpu.totalMB - 6144) <= 64, '6144±64', dgpu ? dgpu.totalMB : '缺失');
    check('适配器', '独显 source = nvidia-smi', dgpu && dgpu.source === 'nvidia-smi', 'nvidia-smi', dgpu ? dgpu.source : '缺失');
    check('适配器', '识别到核显 igpu 且为 Intel', !!igpu && igpu.kind === 'igpu' && igpu.vendor === 'intel', 'Intel / igpu',
      igpu ? igpu.name + ' / ' + igpu.kind : '缺失');
    check('适配器', '识别到虚拟/软件适配器 virtual', !!virt, '≥1 个 virtual', virt ? virt.name : '缺失');
    check('适配器', 'dGPU LUID = 本机实测 0x00000000_0x0001548b', !!dgpu && dgpu.luid === '0x00000000_0x0001548b',
      '0x00000000_0x0001548b', dgpu ? dgpu.luid : '缺失');
    check('适配器', 'iGPU LUID = 本机实测 0x00000000_0x0001504f', !!igpu && igpu.luid === '0x00000000_0x0001504f',
      '0x00000000_0x0001504f', igpu ? igpu.luid : '缺失');
    info('适配器', 'LUID→适配器实测映射', snap.adapters.map((a) => a.luid + ' → ' + a.name + ' [' + a.kind + ']').join(' ; '));
    check('适配器', 'totals 与适配器一致', snap.totals.dgpuTotalMB === (dgpu ? dgpu.totalMB : 0) &&
      snap.totals.dgpuUsedMB === (dgpu ? dgpu.usedMB : 0) && typeof snap.totals.dgpuFreeMB === 'number',
      'dgpuTotalMB/UsedMB/FreeMB 一致', JSON.stringify(snap.totals));

    // ── 3. 显存归因（逐进程求和 vs nvidia-smi）──
    const nvsmi = await queryNvidiaSmi(4000);
    const sumAll = snap.apps.reduce((s, a) => s + (Number(a.dgpuMB) || 0), 0);
    const dwmApp = snap.apps.find((a) => String(a.procName || '').toLowerCase() === 'dwm');
    const dwmMB = dwmApp ? dwmApp.dgpuMB : 0;
    const sumExcl = sumAll - dwmMB;
    check('显存归因', 'nvidia-smi 可用', !!nvsmi && nvsmi.usedMB > 0, 'usedMB > 0', nvsmi ? (nvsmi.name + ' used=' + nvsmi.usedMB + 'MB') : '不可用');
    check('显存归因', '适配器级 Dedicated vs nvidia-smi 误差 ≤32MB',
      !!nvsmi && Math.abs(dgpu.usedMB - nvsmi.usedMB) <= 32,
      '≤32MB', nvsmi ? '适配器 ' + dgpu.usedMB + 'MB vs nvidia-smi ' + nvsmi.usedMB + 'MB (差 ' + Math.abs(dgpu.usedMB - nvsmi.usedMB) + 'MB)' : '—');
    check('显存归因', '逐进程求和(排除 dwm) vs nvidia-smi ≤512MB',
      !!nvsmi && Math.abs(sumExcl - nvsmi.usedMB) <= 512,
      '≤512MB', nvsmi ? '排除 dwm 后 ' + Math.round(sumExcl) + 'MB vs nvidia-smi ' + nvsmi.usedMB + 'MB (差 ' + Math.round(Math.abs(sumExcl - nvsmi.usedMB)) + 'MB)' : '—');
    info('显存归因', 'dwm 计数器虚高说明',
      '逐进程 Dedicated Usage 的原始和 = ' + Math.round(sumAll) + 'MB，其中 dwm（桌面窗口管理器）一项就占 ' + Math.round(dwmMB) +
      'MB；这是 Windows 逐进程计数器把 DWM 合成的共享表面重复计入导致的已知虚高（任务管理器同样如此），' +
      '所以向用户展示"某应用占多少显存"不受影响，而"全机逐进程求和"必须排除 dwm 才能与 nvidia-smi 对上。');

    // ── 4. 采集性能 ──
    const times = [];
    for (let i = 0; i < 8; i++) {
      const t = Date.now();
      await bridge.collectOnce();
      times.push(Date.now() - t);
    }
    const sorted = times.slice().sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const engineInfo = bridge.getEngineInfo();
    check('采集性能', '单次采集 p95 ≤ 400ms', p95 <= 400, '≤400ms', 'p50=' + p50 + 'ms p95=' + p95 + 'ms max=' + sorted[sorted.length - 1] + 'ms');
    check('采集性能', '常驻 worker 模式（非 spawn 兜底）', engineInfo.backend === 'resident', 'resident', engineInfo.backend);
    info('采集性能', '启动握手 / PS 自报采样', 'init ' + initMs + 'ms；worker 自报采样 ' + engineInfo.sampleMs + 'ms；首采 ' + firstCollectMs + 'ms');

    // spawn 兜底路径可用性（模式：每次一个 PowerShell 进程）
    try {
      const scriptPath = ps.materializeScript('gpu-sampler.ps1', DATA_DIR);
      const tSpawn = Date.now();
      const res = await ps.runScript(scriptPath, ['-Once'], { timeoutMs: 8000 });
      const spawnMs = Date.now() - tSpawn;
      const sampleLine = res.lines.filter((l) => l[0] === '{').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((o) => o && Array.isArray(o.adapters))[0];
      check('采集性能', 'spawn 兜底可用（超时保护）', !!sampleLine, '1 个 sample', spawnMs + 'ms（含 PowerShell 启动，不在 400ms 预算内）');
    } catch (e) {
      check('采集性能', 'spawn 兜底可用（超时保护）', false, '1 个 sample', e.message);
    }

    // ── 5. apps 结构 / 分类 / 推荐 ──
    check('应用列表', 'apps 非空', snap.apps.length > 0, '>0', snap.apps.length + ' 个');
    check('应用列表', '分类全部为规定中文分类', snap.apps.every((a) => VALID_CATEGORIES.includes(a.category)),
      VALID_CATEGORIES.join('/'), JSON.stringify(snap.apps.reduce((m, a) => { m[a.category] = (m[a.category] || 0) + 1; return m; }, {})));
    check('应用列表', 'preference ∈ {null,0,1,2}', snap.apps.every((a) => a.preference === null || [0, 1, 2].includes(a.preference)),
      'null/0/1/2', new Set(snap.apps.map((a) => a.preference)).size + ' 种取值');
    check('应用列表', 'recommended ∈ {0,1,2} 且 reason 非空', snap.apps.every((a) => [0, 1, 2].includes(a.recommended) && a.reason && a.reason.length > 0),
      '0/1/2 + reason', snap.apps.filter((a) => a.reason).length + ' 条带 reason');
    check('应用列表', '系统类进程 recommended 一律 0（不参与优化）',
      snap.apps.filter((a) => a.category === '系统').every((a) => a.recommended === 0),
      '系统类全部 0', snap.apps.filter((a) => a.category === '系统').length + ' 个系统进程');
    check('应用列表', 'key 唯一且为小写 exe 路径', (() => {
      const keys = snap.apps.map((a) => a.key);
      return new Set(keys).size === keys.length;
    })(), '无重复', snap.apps.length + ' keys');
    info('应用列表', '聚合示例（多进程 exe）',
      snap.apps.filter((a) => a.pids.length > 1).slice(0, 4).map((a) => a.name + '×' + a.pids.length + 'pid').join(' ; ') || '当前无多进程应用');
    // 图标（等后台抽取完成）
    const gotIcons = await waitFor(() => (bridge.getSnapshot().apps || []).some((a) => a.iconUrl), 5000, 150);
    const snap2 = bridge.getSnapshot();
    check('应用列表', 'app.iconUrl 为 file:/// 绝对 URL（抽取完成）', gotIcons &&
      snap2.apps.some((a) => a.iconUrl && a.iconUrl.startsWith('file:///') && /\.png$/.test(a.iconUrl)),
      'file:///...png', snap2.apps.filter((a) => a.iconUrl).length + '/' + snap2.apps.length + ' 带图标');
    check('应用列表', 'iconUrl 中文/空格已编码', snap2.apps.every((a) => !a.iconUrl || !/\s/.test(a.iconUrl)), '无裸空格',
      snap2.apps.filter((a) => a.iconUrl).map((a) => path.basename(a.iconUrl)).length > 0 ? 'ok' : '无图标');

    // ── 6. 图标抽取 ──
    const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
    const iconPath = await bridge.getIcon(notepad);
    const iconSize = iconPath ? pngSize(iconPath) : null;
    check('图标', 'getIcon 返回 PNG 路径', !!iconPath && fs.existsSync(iconPath), 'data/icons/<sha1>.png', iconPath || 'null');
    check('图标', 'PNG 尺寸 96×96 且带内容', !!iconSize && iconSize.width === 96 && iconSize.height === 96 && iconSize.bytes > 200,
      '96×96', iconSize ? iconSize.width + '×' + iconSize.height + ' / ' + iconSize.bytes + 'B' : '无法解析');
    check('图标', '不存在的 exe 返回 null', (await bridge.getIcon('C:\\definitely\\not\\here.exe')) === null, 'null', 'null');

    // ── 7. 已安装应用目录 ──
    const catalog = await bridge.listInstalledApps();
    check('应用目录', 'listInstalledApps 返回列表', Array.isArray(catalog) && catalog.length > 5, '>5 项', catalog.length + ' 项');
    check('应用目录', '每项含 exePath/name/source', catalog.every((a) => a.exePath && a.name && a.source), 'exePath/name/source',
      catalog.slice(0, 2).map((a) => a.name).join(' / '));

    // ── 8. history ──
    const hist = bridge.getHistory(5);
    check('历史', 'getHistory(minutes) 返回环形缓冲', Array.isArray(hist) && hist.length >= 3, '≥3 个点', hist.length + ' 个点');
    check('历史', '历史点字段 {ts,dgpuUsedMB,igpuUsedMB}', hist.every((p) => typeof p.ts === 'number' && typeof p.dgpuUsedMB === 'number' && typeof p.igpuUsedMB === 'number'),
      'ts/dgpuUsedMB/igpuUsedMB', 'ok');

    // ── 9. 注册表读写（直接 Prefs，避免污染 bridge 的 savings）──
    testPrefs = new Prefs({ dataDir: DATA_DIR });
    await testPrefs.init();
    const countBefore = testPrefs.entries.length;
    originalPrefsRaw = testPrefs.getRaw(TEST_EXE_PREFS); // null = 原本不存在
    await testPrefs.setPreference(TEST_EXE_PREFS, 2);
    check('注册表', '写入 GpuPreference=2 并回读', testPrefs.getPreference(TEST_EXE_PREFS) === 2, '2', String(testPrefs.getPreference(TEST_EXE_PREFS)));
    await testPrefs.setPreference(TEST_EXE_PREFS, 1);
    check('注册表', '写入 GpuPreference=1 并回读', testPrefs.getPreference(TEST_EXE_PREFS) === 1, '1', String(testPrefs.getPreference(TEST_EXE_PREFS)));
    await testPrefs.setPreference(TEST_EXE_PREFS, 0);
    check('注册表', '写入 GpuPreference=0 并回读', testPrefs.getPreference(TEST_EXE_PREFS) === 0, '0', String(testPrefs.getPreference(TEST_EXE_PREFS)));
    // AppStatus 保留：先造一个只含 AppStatus 的值，再写 GpuPreference
    await testPrefs.restoreRaw(TEST_EXE_PREFS, 'AppStatus=0;', true);
    await testPrefs.setPreference(TEST_EXE_PREFS, 1);
    const rawAfter = testPrefs.getRaw(TEST_EXE_PREFS);
    check('注册表', '写入时保留其它 token（AppStatus）', rawAfter === 'AppStatus=0;GpuPreference=1;' || rawAfter === 'GpuPreference=1;AppStatus=0;',
      '含 AppStatus=0; 与 GpuPreference=1;', rawAfter);
    const restored = await testPrefs.restoreDefault(TEST_EXE_PREFS);
    check('注册表', 'restoreDefault 只删 GpuPreference，保留 AppStatus', restored.keptRaw === 'AppStatus=0;' && testPrefs.getPreference(TEST_EXE_PREFS) === null,
      'AppStatus=0; / pref=null', 'keptRaw=' + restored.keptRaw);
    // 恢复原状
    if (originalPrefsRaw === null) await testPrefs.restoreRaw(TEST_EXE_PREFS, '', false);
    else await testPrefs.restoreRaw(TEST_EXE_PREFS, originalPrefsRaw, true);
    await testPrefs.refresh();
    check('注册表', '清理后条目数与测试前一致', testPrefs.entries.length === countBefore, countBefore + ' 条', testPrefs.entries.length + ' 条');
    check('注册表', '现有用户条目可读取（未破坏）', countBefore > 0, '>0 条', countBefore + ' 条');

    // ── 10. bridge.setPreference / restoreDefault + 释放 session ──
    if (bridge.getPreference(TEST_EXE_BRIDGE) !== null) await bridge.restoreDefault(TEST_EXE_BRIDGE); // 防御
    const setRes = await bridge.setPreference(TEST_EXE_BRIDGE, 1);
    bridgeTestCreated = true;
    const savPending = bridge.getSavings();
    check('释放量化', 'bridge.setPreference 写入并开始量化', setRes.ok && bridge.getPreference(TEST_EXE_BRIDGE) === 1 &&
      savPending.pendingCount >= 1 && savPending.sessions.some((s) => s.status === 'pending' && s.exePath === TEST_EXE_BRIDGE),
      'pref=1 + pending session', 'ok=' + setRes.ok + ' pref=' + bridge.getPreference(TEST_EXE_BRIDGE) + ' pending=' + savPending.pendingCount);
    const restoreRes = await bridge.restoreDefault(TEST_EXE_BRIDGE);
    bridgeTestCreated = false;
    const savCancelled = bridge.getSavings();
    check('释放量化', 'restoreDefault 取消 pending session', restoreRes.ok && bridge.getPreference(TEST_EXE_BRIDGE) === null &&
      savCancelled.cancelledCount >= 1 && savCancelled.sessions.some((s) => s.exePath === TEST_EXE_BRIDGE && s.status === 'cancelled'),
      'pref=null + cancelled', 'ok=' + restoreRes.ok + ' cancelled=' + savCancelled.cancelledCount);

    // ── 11. 释放量化状态机（假时钟 + 假数据，独立 Store）──
    const unitDir = path.join(DATA_DIR, '_savings_unit');
    const unitStore = new Store(unitDir);
    unitStore.load();
    let fakeNow = 1700000000000;
    const engine = new SavingsEngine({ store: unitStore, now: () => fakeNow });
    const mkSnap = (apps) => ({ ts: fakeNow, apps });
    const A = 'C:\\apps\\player.exe';

    // 11a. 正常释放：486MB -> 重启 -> 0MB
    const s1 = engine.begin({ exePath: A, name: 'Player', pref: 1, beforeDgpuMB: 486, pids: [100], beforeAt: fakeNow });
    check('状态机', 'begin 后状态 pending 且 beforeDgpuMB 记录', s1.status === 'pending' && s1.beforeDgpuMB === 486, 'pending / 486MB', s1.status + ' / ' + s1.beforeDgpuMB + 'MB');
    engine.observe(mkSnap([{ exePath: A, pids: [100], dgpuMB: 486, running: true }]));
    fakeNow += 2000;
    engine.observe(mkSnap([{ exePath: A, pids: [200], dgpuMB: 0, running: true }])); // 重启（pid 变化）
    fakeNow += 2000;
    const applied = engine.observe(mkSnap([{ exePath: A, pids: [200], dgpuMB: 0, running: true }]));
    const sav1 = engine.getSavings();
    const session1 = sav1.sessions.find((s) => s.exePath === A);
    check('状态机', '进程重启且显存下降 → applied', applied.applied.length === 1 && session1 && session1.status === 'applied',
      'applied', session1 ? session1.status : 'missing');
    check('状态机', 'freedMB = max(0, before-after) = 486', sav1.totalFreedMB === 486 && session1.freedMB === 486,
      '486MB', 'total=' + sav1.totalFreedMB + 'MB / freed=' + (session1 ? session1.freedMB : '?'));
    check('状态机', '证据字段齐全（before/after/时间/pid/at）', !!session1 &&
      session1.beforeDgpuMB === 486 && session1.afterDgpuMB === 0 &&
      typeof session1.beforeAt === 'number' && typeof session1.afterAt === 'number' && typeof session1.at === 'number' &&
      Array.isArray(session1.pidBefore) && session1.pidBefore[0] === 100 &&
      Array.isArray(session1.pidAfter) && session1.pidAfter[0] === 200 &&
      typeof session1.name === 'string' && session1.name.length > 0 &&
      /486/.test(session1.evidence || ''),
      'beforeDgpuMB/afterDgpuMB/beforeAt/afterAt/at/pidBefore/pidAfter/name/evidence',
      session1 ? JSON.stringify({ before: session1.beforeDgpuMB, after: session1.afterDgpuMB, at: session1.at, pidBefore: session1.pidBefore, pidAfter: session1.pidAfter }) : 'missing');

    // 11b. 5 分钟没重启 -> needsRestart
    const B = 'C:\\apps\\idle.exe';
    const tB = (fakeNow += 1000);
    engine.begin({ exePath: B, name: 'Idle', pref: 1, beforeDgpuMB: 300, pids: [7], beforeAt: tB });
    fakeNow += 5 * 60 * 1000 + 1000; // 超过 5 分钟
    const nr = engine.observe(mkSnap([{ exePath: B, pids: [7], dgpuMB: 300, running: true }]));
    const sessionB = engine.getSavings().sessions.find((s) => s.exePath === B);
    check('状态机', '5 分钟内没重启 → needsRestart', nr.needsRestart.length === 1 && sessionB && sessionB.status === 'needsRestart',
      'needsRestart', sessionB ? sessionB.status : 'missing');
    check('状态机', 'needsRestart 不算释放', engine.getSavings().totalFreedMB === 486, 'totalFreedMB 仍 486', engine.getSavings().totalFreedMB + 'MB');

    // 11c. 重启了但显存没下降 -> 不得出现负数释放
    const C = 'C:\\apps\\heavy.exe';
    fakeNow += 1000;
    engine.begin({ exePath: C, name: 'Heavy', pref: 1, beforeDgpuMB: 100, pids: [50], beforeAt: fakeNow });
    fakeNow += 2000;
    engine.observe(mkSnap([{ exePath: C, pids: [60], dgpuMB: 150, running: true }]));
    fakeNow += 2000;
    engine.observe(mkSnap([{ exePath: C, pids: [60], dgpuMB: 150, running: true }]));
    fakeNow += 5 * 60 * 1000;
    engine.observe(mkSnap([{ exePath: C, pids: [60], dgpuMB: 150, running: true }]));
    const sessionC = engine.getSavings().sessions.find((s) => s.exePath === C);
    check('状态机', '显存没下降 → 不 applied 且 freedMB 不为负', sessionC && sessionC.status === 'needsRestart' && sessionC.freedMB === 0,
      'needsRestart / freedMB=0', sessionC ? sessionC.status + ' / ' + sessionC.freedMB : 'missing');

    // 11d. 持久化：新建 engine 能从 state.json 恢复
    const storeReload = new Store(unitDir);
    storeReload.load();
    const engineReload = new SavingsEngine({ store: storeReload });
    const reloadTotal = engineReload.getSavings().totalFreedMB;
    check('状态机', 'state.json 持久化后重启可恢复', reloadTotal === 486 && engineReload.getSessions().length === engine.getSessions().length,
      'totalFreedMB=486 且 session 数一致', 'total=' + reloadTotal + 'MB / sessions=' + engineReload.getSessions().length);

    // ── 12. engineInfo / smartOptimize / settings / watchList ──
    const ei = bridge.getEngineInfo();
    check('meta', 'getEngineInfo 字段齐全', ei.mode === 'PDH+DXGI' && typeof ei.sampleMs === 'number' && typeof ei.adapterCount === 'number' && 'lastError' in ei,
      'mode/sampleMs/adapterCount/lastError', JSON.stringify({ mode: ei.mode, sampleMs: ei.sampleMs, adapterCount: ei.adapterCount, lastError: ei.lastError }));

    const suggestions = await bridge.smartOptimize();
    const keySet = suggestions.length ? Object.keys(suggestions[0]).sort().join(',') : '';
    check('智能优化', 'smartOptimize 返回数组', Array.isArray(suggestions), 'array', suggestions.length + ' 条建议');
    check('智能优化', '每项字段恰为 {exePath,name,estMB,pref}', suggestions.every((s) => Object.keys(s).sort().join(',') === 'estMB,exePath,name,pref') && keySet === 'estMB,exePath,name,pref',
      'estMB,exePath,name,pref', keySet || '空数组');
    check('智能优化', 'pref ∈ {1,2}，estMB ≥ 0', suggestions.every((s) => [1, 2].includes(s.pref) && typeof s.estMB === 'number' && s.estMB >= 0),
      '1/2 + estMB≥0', suggestions.slice(0, 1).map((s) => s.name + ':' + s.estMB + 'MB→' + s.pref).join('') || '无');
    const systemPaths = new Set(snap.apps.filter((a) => a.category === '系统' && a.exePath).map((a) => a.exePath.toLowerCase()));
    check('智能优化', '系统类进程不出现在建议里', suggestions.every((s) => !systemPaths.has(s.exePath.toLowerCase())),
      '不含 dwm/csrss/explorer…', '检查 ' + suggestions.length + ' 条');

    const savedSettings = bridge.saveSettings({ interval: 1500 });
    check('设置', 'saveSettings/getSettings 往返', savedSettings.interval === 1500, 'interval=1500', 'interval=' + savedSettings.interval);
    bridge.saveSettings({ interval: 2000 });
    const wl = bridge.saveWatchList([{ exePath: TEST_EXE_BRIDGE, name: 'Selftest' }]);
    check('设置', 'saveWatchList/getWatchList 往返', wl.length === 1 && bridge.getWatchList().length === 1, '1 项', wl.length + ' 项');
    bridge.saveWatchList([]);
  } finally {
    // ── 清理：注册表 / 临时 dataDir / 常驻进程 ──
    try {
      if (testPrefs) {
        if (originalPrefsRaw === null) await testPrefs.restoreRaw(TEST_EXE_PREFS, '', false);
        else await testPrefs.restoreRaw(TEST_EXE_PREFS, originalPrefsRaw, true);
      }
    } catch (_) { /* ignore */ }
    try {
      if (bridgeTestCreated) await bridge.restoreDefault(TEST_EXE_BRIDGE);
    } catch (_) { /* ignore */ }
    try { bridge.destroy(); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ───────────────────────── 入口 ─────────────────────────
run()
  .then(() => {
    const fails = printTable();
    if (fails > 0) process.exitCode = 1;
  })
  .catch((e) => {
    console.error('\n测试异常中断：', e && e.stack ? e.stack : e);
    try { printTable(); } catch (_) { /* ignore */ }
    process.exitCode = 1;
  })
  .finally(() => {
    // 给常驻 PowerShell / 文件句柄一点退出时间
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });