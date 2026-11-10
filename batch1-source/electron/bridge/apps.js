'use strict';
/**
 * apps.js — 把逐进程计数器聚合成 SPEC 的 `apps` 列表（按 exe 路径聚合，浏览器多进程合并），
 *           并给出中文分类 / GPU 推荐策略 / reason。
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ 规则表（想调整推荐策略就改这里，不用动逻辑代码）                              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * CATEGORY_RULES : 从上到下匹配，命中即停；匹配对象是 "进程名 + exe 全路径" 的小写串。
 * RECOMMEND_RULES: category -> { pref, reason }，pref = 0 默认 / 1 核显 / 2 独显。
 *   额外覆盖：
 *     - 目标应用 dgpuMB >= HEAVY_DGPU_MB（1536MB）且不是「系统」类 -> 2（重负载，别赶去核显）
 *     - 系统类永远 0（不干预系统组件）
 */
const HEAVY_DGPU_MB = 1536;
const MB = 1024 * 1024;

const CATEGORY_RULES = [
  {
    category: '模拟器',
    patterns: [
      /bluestacks|hd-player|hd-gicheck|dnplayer|ldplayer|leidian|nemu|mumu(?:player|emulator)?|nox(?:player)?|memu|genymotion|gameloop|androidemulator/i,
    ],
  },
  {
    // 动态壁纸：虽然可能装在 steamapps\common 下，但不是游戏；走核显可以省显存
    category: '影音',
    patterns: [/wallpaper_engine|wallpaper32\.exe|wallpaper64\.exe/i],
  },
  {
    category: '游戏',
    patterns: [
      /\\steamapps\\common\\/i, /\\games?\\/i, /\\game\s*[\\/]/i, /\\epic games\\/i,
      /\\riot games\\/i, /\\blizzard\\/i, /\\ubisoft\\/i, /\\battle\.net\\/i,
      /\\(?:re4|bh3|genshin|yuanshen|starrail|zenless|minecraft|wow|dota2|cs2?|lol|league of legends|valorant|apex|pubg|eldenring|cyberpunk2077|gta5?)(?:\.exe)?$/i,
    ],
  },
  {
    category: '启动器',
    patterns: [
      /\\steam(?:webhelper)?\.exe$/i, /\\steam\.exe$/i, /steamwebhelper/i,
      /epicgameslauncher|epicwebhelper|battle\.net|blizzard launcher|origin\.exe|eaapp|eadesktop|uplay|ubisoftconnect|goggalaxy|wegame\.exe|biubiu\.exe|riotclient|gameloop|gamepp/i,
    ],
  },
  {
    category: '浏览器',
    patterns: [
      /chrome\.exe|msedge(?:webview2)?|firefox|brave\.exe|opera\.exe|vivaldi|360se|360chrome|qqbrowser|sogouexplorer|2345explorer|maxthon|arc\.exe/i,
    ],
  },
  {
    category: '社交通讯',
    patterns: [
      /wechat|weixin|wechatappex|\\qq(?:nt)?\.exe|qqnt|tim\.exe|dingtalk|feishu|lark|telegram|discord|whatsapp|skype|teams\.exe|line\.exe|signal\.exe|yy\.exe|kook/i,
    ],
  },
  {
    category: '影音',
    patterns: [
      /potplayer|vlc\.exe|mpc-hc|mpc-be|mpv|bilibili|iqiyi|youku|tencentvideo|qqlive|cloudmusic|netease\\cloudmusic|qqmusic|kugou|kuwo|spotify|foobar|obs64?\.exe|audacity|handbrake|premiere|after effects|davinci|剪映|jianying/i,
    ],
  },
  {
    category: '开发工具',
    patterns: [
      /\\code\.exe$|vscode|devenv\.exe|idea64?\.exe|pycharm|webstorm|goland|clion|rider|androidstudio|sublime_text|notepad\+\+|git(?:\.exe)?|node\.exe|python\d*\.exe|\\windowsterminal|wt\.exe|powershell\.exe|pwsh\.exe|cmd\.exe|docker|postman|fiddler|wireshark|xshell|navicat|sourcetree|hbuilder|unity\.exe|unrealeditor|blender|3dsmax|maya\.exe|adb\.exe|qemu|virtualbox|vmware|hwinfo|cpu-z|gpu-z|aida64|mchose|omen|nvcontainer|nvidia|amd|rocketdock|wallpaper64?\.exe|deskbox/i,
    ],
  },
  {
    category: '系统',
    patterns: [
      /\\dwm\.exe$|\\csrss\.exe$|\\winlogon\.exe$|\\services\.exe$|\\svchost\.exe$|\\system$|\\registry$|\\memory compression$|\\smss\.exe$|\\lsass\.exe$|\\wininit\.exe$|\\spoolsv\.exe$|\\taskhostw\.exe$|\\sihost\.exe$|\\ctfmon\.exe$|\\explorer\.exe$|\\searchhost\.exe$|searchapp\.exe|\\startmenuexperiencehost|\\shellhost\.exe$|\\applicationframehost|\\runtimebroker|\\systemsettings\.exe$|\\textinputhost|\\tabtip\.exe$|\\securityhealth|\\widgetboard|\\widgetservice|\\lockapp\.exe$|\\smartscreen|\\consent\.exe$|\\backgroundtaskhost|\\gamebar|\\nvcontainer|\\hipsdaemon|\\hipstray|\\hrsword|\\audiodg\.exe$|\\wmiprvse\.exe$|\\dllhost\.exe$|\\msmpeng\.exe$|\\nissrv\.exe$|\\phoneexperiencehost|\\crossdeviceresume|\\shellexperiencehost|\\usoclient|\\musnotification|\\compattelrunner|\\wwahost|\\startmenuexperiencehost/i,
    ],
    // 受保护进程（dwm/csrss/System …）拿不到 exe 路径，只能按进程名识别
    namePatterns: [
      /^(dwm|csrss|winlogon|services|svchost|system|registry|smss|lsass|wininit|spoolsv|taskhostw|sihost|ctfmon|explorer|searchhost|searchapp|startmenuexperiencehost|shellexperiencehost|shellhost|applicationframehost|runtimebroker|systemsettings|textinputhost|tabtip|securityhealth|widgetboard|widgetservice|lockapp|smartscreen|consent|backgroundtaskhost|gamebar|nvcontainer|audiodg|wmiprvse|dllhost|msmpeng|nissrv|phoneexperiencehost|crossdeviceresume|usoclient|musnotification|compattelrunner|wwahost|memory compression|fontdrvhost|hipsdaemon|hipstray|hrsword)$/i,
    ],
  },
];

const RECOMMEND_RULES = {
  浏览器: { pref: 1, reason: '浏览器合成与视频解码核显足够，独显留给游戏' },
  社交通讯: { pref: 1, reason: '后台常驻，核显足够' },
  影音: { pref: 1, reason: '视频解码核显足够' },
  启动器: { pref: 1, reason: '启动器界面无需独显' },
  模拟器: { pref: 1, reason: '模拟器多开占用显存，转核显可释放' },
  开发工具: { pref: 1, reason: '界面渲染核显足够（重负载应用会单独判定）' },
  游戏: { pref: 2, reason: '需要独显性能' },
  系统: { pref: 0, reason: '系统组件建议保持默认' },
  其它: { pref: 0, reason: '无明确负载特征，保持系统默认' },
};

const VALID_CATEGORIES = Object.keys(RECOMMEND_RULES);

function classify(exePath, name, procName) {
  const hay = ((name || '') + ' ' + (exePath || '')).toLowerCase();
  const bare = String(procName || '').trim().toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns) {
      for (const re of rule.patterns) {
        if (re.test(hay)) return rule.category;
      }
    }
    if (rule.namePatterns) {
      for (const re of rule.namePatterns) {
        if (re.test(bare)) return rule.category;
      }
    }
  }
  return '其它';
}

/** @returns {{recommended:0|1|2, reason:string, category:string}} */
function recommend(app) {
  const category = app && app.category ? app.category : classify(app && app.exePath, app && app.name, app && app.procName);
  const base = RECOMMEND_RULES[category] || RECOMMEND_RULES['其它'];
  const dgpuMB = Math.max(0, Math.round(Number(app && app.dgpuMB) || 0));
  if (category !== '系统' && dgpuMB >= HEAVY_DGPU_MB) {
    return { recommended: 2, reason: `独显占用 ${dgpuMB}MB，属重负载，建议保留高性能`, category };
  }
  if (category === '游戏') {
    return { recommended: 2, reason: base.reason, category };
  }
  return { recommended: base.pref, reason: base.reason, category };
}

function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function prettifyName(desc, processName, exePath) {
  const d = String(desc || '').trim();
  if (d && !/^microsoft.*windows.*operating system/i.test(d) && !/^windows.*operating system/i.test(d)) return d;
  const n = String(processName || '').trim() || baseName(exePath).replace(/\.exe$/i, '');
  return n;
}

function normKey(p) { return String(p || '').toLowerCase(); }

/**
 * @param {object} raw    raw sample from counters.js
 * @param {object} ctx    { prefs, adapters, iconUrlFor }
 * @returns {object[]}    SPEC apps array
 */
function buildApps(raw, ctx) {
  const c = ctx || {};
  const prefs = c.prefs || null;
  const adapters = Array.isArray(c.adapters) ? c.adapters : [];
  const iconUrlFor = typeof c.iconUrlFor === 'function' ? c.iconUrlFor : null;
  const luidKind = new Map();
  for (const a of adapters) luidKind.set(String(a.luid).toLowerCase(), a.kind);
  const dgpuLuids = new Set(adapters.filter((a) => a.kind === 'dgpu').map((a) => String(a.luid).toLowerCase()));
  const igpuLuids = new Set(adapters.filter((a) => a.kind === 'igpu').map((a) => String(a.luid).toLowerCase()));

  const procInfo = new Map();
  for (const row of (raw && raw.procs) || []) {
    if (!Array.isArray(row)) continue;
    procInfo.set(row[0], { pid: row[0], path: row[1] || '', name: row[2] || '', desc: row[3] || '', hasWindow: !!row[4] });
  }

  /** @type {Map<string, object>} */
  const groups = new Map();

  function ensureGroup(pid, info) {
    const hasPath = !!(info && info.path);
    const key = hasPath ? normKey(info.path) : ('pid:' + pid);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        exePath: hasPath ? info.path : '',
        name: hasPath ? prettifyName(info.desc, info.name, info.path) : (info ? info.name || ('PID ' + pid) : 'PID ' + pid),
        procName: info && info.name ? info.name : '',
        pids: new Set(),
        dgpuMB: 0,
        igpuMB: 0,
        sharedMB: 0,
        engines: {},
        hasWindow: false,
      };
      groups.set(key, g);
    }
    g.pids.add(pid);
    if (info && info.hasWindow) g.hasWindow = true;
    return g;
  }

  // 1) 显存行（逐 pid × 逐 luid）
  for (const row of (raw && raw.processes) || []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const pid = row[0];
    const luid = normKey(row[1]);
    const ded = Number(row[2]) || 0;
    const shared = Number(row[3]) || 0;
    const info = procInfo.get(pid) || null;
    const g = ensureGroup(pid, info);
    const kind = luidKind.get(luid);
    if (kind === 'dgpu') {
      g.dgpuMB += ded / MB;
      g.sharedMB += shared / MB;
    } else if (kind === 'igpu') {
      g.igpuMB += (ded + shared) / MB;
    } else {
      // 虚拟/软件适配器（Microsoft Basic Render Driver）：不计入独显/核显占用
    }
  }

  // 2) 有窗口但完全没有 GPU 计数的进程（SPEC: 有窗口也算“运行中应用”）
  for (const info of procInfo.values()) {
    if (!info.hasWindow) continue;
    const g = ensureGroup(info.pid, info);
    g.hasWindow = true;
  }

  // 3) GPU 利用率（逐 pid × engtype，百分比；按引擎实例求和后每类封顶 100）
  for (const row of (raw && raw.engines) || []) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const pid = row[0];
    const engtype = String(row[2] || 'Other');
    const util = Number(row[3]) || 0;
    const info = procInfo.get(pid) || null;
    if (!info) continue;
    const g = ensureGroup(pid, info);
    g.engines[engtype] = Math.min(100, (g.engines[engtype] || 0) + util);
  }

  const apps = [];
  for (const g of groups.values()) {
    const pids = Array.from(g.pids).sort((a, b) => a - b);
    if (pids.length === 0) continue;
    const dgpuMB = Math.round(g.dgpuMB);
    const igpuMB = Math.round(g.igpuMB);
    const sharedMB = Math.round(g.sharedMB);
    const totalMB = dgpuMB + igpuMB + sharedMB;
    if (!(totalMB > 0 || Object.keys(g.engines).length > 0 || g.hasWindow)) continue;
    const category = classify(g.exePath, g.name, g.procName);
    const preference = g.exePath && prefs ? prefs.getPreference(g.exePath) : null;
    const rec = recommend({ category, dgpuMB, exePath: g.exePath, name: g.name, procName: g.procName });
    const app = {
      key: g.key,
      name: g.name,
      exePath: g.exePath,
      procName: g.procName,
      pid: pids[0],
      pids,
      category,
      preference: preference == null ? null : preference,
      recommended: rec.recommended,
      reason: rec.reason,
      dgpuMB,
      igpuMB,
      sharedMB,
      totalMB,
      engines: g.engines,
      running: true,
      hasWindow: g.hasWindow,
      // file:/// URL of the cached 96px PNG (null until the extractor finished; next tick fills it)
      iconUrl: g.exePath && iconUrlFor ? (iconUrlFor(g.exePath) || null) : null,
    };
    apps.push(app);
  }

  apps.sort((a, b) => (b.dgpuMB - a.dgpuMB) || (b.totalMB - a.totalMB) || String(a.name).localeCompare(String(b.name)));
  return apps;
}

module.exports = {
  CATEGORY_RULES,
  RECOMMEND_RULES,
  VALID_CATEGORIES,
  HEAVY_DGPU_MB,
  classify,
  recommend,
  buildApps,
};