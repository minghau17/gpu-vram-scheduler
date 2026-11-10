'use strict';
/** app.js — 渲染层：状态、路由、四个页面、交互。无框架、无构建。 */
(function () {
  const api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');

  /* ── 工具 ─────────────────────────────────────────────── */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gb = (mb) => ((Number(mb) || 0) / 1024);
  const gbText = (mb, d) => {
    const v = gb(mb);
    const digits = d != null ? d : (v >= 10 ? 1 : 2);
    return v.toFixed(digits);
  };
  const mbText = (mb) => (Number(mb) >= 1024 ? gbText(mb, 2) + ' GB' : Math.round(Number(mb) || 0) + ' MB');
  const timeText = (ts) => {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const dateText = (ts) => {
    const d = new Date(ts || Date.now());
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const pct = (a, b) => (!b ? 0 : Math.max(0, Math.min(1, a / b)));

  /* ── 图标 ─────────────────────────────────────────────── */
  const P = {
    gauge: '<path d="M12 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M13.4 10.6 16 8"/><path d="M3.5 17a9 9 0 1 1 17 0"/>',
    apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l3.5-4 3 2.5L20 7"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    spark: '<path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/>',
    play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
    check: '<path d="m4 12.5 5 5L20 6.5"/>',
    x: '<path d="M5 5l14 14M19 5 5 19"/>',
    minus: '<path d="M4 12h16"/>',
    arrowUp: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
    download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M5 19h14"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.4h7.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.5Z"/>',
    cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.5 6.4"/><path d="M20 5v6h-6"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    warn: '<path d="M12 4.5 21 19.5H3L12 4.5Z"/><path d="M12 10v4M12 16.6v.2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8.2v.2"/>',
    restart: '<path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1"/><path d="M3.5 18v-5.5H9"/>',
  };
  const ico = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24">${P[name] || ''}</svg>`;

  /* ── 状态 ─────────────────────────────────────────────── */
  const state = {
    page: 'dashboard',
    data: null,
    history: [],
    range: 10,
    query: '',
    filter: 'all',
    sort: 'mb',
    selected: new Set(),
    measure: null,
    hover: null,
    animate: true,
    busy: false,
    calcGB: 6,
  };

  const PAGES = {
    dashboard: { title: '概览', sub: '实时显存 · 智能分流', icon: 'gauge' },
    apps: { title: '应用调度', sub: '按程序分配显卡 · 注册表级生效', icon: 'apps' },
    insights: { title: '收益实测', sub: '切换前后真实采样 · 可验证的释放量', icon: 'chart' },
    settings: { title: '设置', sub: '采样、外观与自动分流', icon: 'gear' },
  };

  /* ── Toast ───────────────────────────────────────────── */
  function toast(msg, kind = 'ok', ms = 3200) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `${ico(kind === 'ok' ? 'check' : kind === 'warn' ? 'warn' : 'x')}<span>${esc(msg)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }, ms);
  }

  /* ── Sheet ───────────────────────────────────────────── */
  const sheetLayer = $('#sheetLayer');
  function closeSheet() {
    sheetLayer.hidden = true;
    sheetLayer.innerHTML = '';
  }
  function openSheet({ title, sub, body, actions }) {
    sheetLayer.hidden = false;
    sheetLayer.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${sub ? `<p class="sub">${sub}</p>` : ''}
        ${body || ''}
        <div class="sheet-actions">${actions || '<button class="btn btn-ghost" data-sheet-close>关闭</button>'}</div>
      </div>`;
    sheetLayer.querySelectorAll('[data-sheet-close]').forEach((b) => b.addEventListener('click', closeSheet));
    return sheetLayer.querySelector('.sheet');
  }
  sheetLayer.addEventListener('click', (e) => { if (e.target === sheetLayer) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!sheetLayer.hidden) closeSheet();
      else if (state.selected.size) { state.selected.clear(); render(); }
    }
  });

  /* ── 数据访问 ─────────────────────────────────────────── */
  const snap = () => (state.data && state.data.snapshot) || { adapters: [], apps: [], totals: {} };
  const insights = () => (state.data && state.data.insights) || { pendingMB: 0, suggestMB: 0, suggestCount: 0, suggestTop: [], freeMB: 0 };
  const savings = () => (state.data && state.data.savings) || { totalFreedMB: 0, sessions: [] };
  const settings = () => (state.data && state.data.settings) || {};
  const adapter = (kind) => (snap().adapters || []).find((a) => a.kind === kind) || null;

  function appList() {
    const q = state.query.trim().toLowerCase();
    // 拿不到 exe 路径的进程无法写注册表，不进调度列表
    let list = (snap().apps || []).filter((a) => a.exePath);
    if (q) list = list.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.exePath || '').toLowerCase().includes(q));
    switch (state.filter) {
      case 'igpu': list = list.filter((a) => a.preference === 1); break;
      case 'dgpu': list = list.filter((a) => a.preference === 2); break;
      case 'auto': list = list.filter((a) => a.preference == null || a.preference === 0); break;
      case 'pending': list = list.filter((a) => a.preference === 1 && (a.dgpuMB || 0) > 8); break;
      case 'window': list = list.filter((a) => a.hasWindow); break;
      default: break;
    }
    const by = state.sort;
    list.sort((a, b) => {
      if (by === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      if (by === 'pref') return (a.preference == null ? 9 : a.preference) - (b.preference == null ? 9 : b.preference) || (b.dgpuMB || 0) - (a.dgpuMB || 0);
      return (b.dgpuMB || 0) - (a.dgpuMB || 0);
    });
    return list;
  }

  /* ── 外壳渲染 ─────────────────────────────────────────── */
  function renderShell() {
    const apps = snap().apps || [];
    const nav = Object.entries(PAGES).map(([k, p]) => {
      const badge = k === 'apps' ? `<span class="badge num">${apps.length}</span>` : '';
      return `<button class="nav-item ${state.page === k ? 'on' : ''}" data-nav="${k}">${ico(p.icon)}<span>${p.title}</span>${badge}</button>`;
    }).join('');
    $('#nav').innerHTML = nav;

    const d = adapter('dgpu');
    const i = adapter('igpu');
    $('#railFoot').innerHTML = `
      ${d ? `<div class="gpu-chip" title="${esc(d.name)}">
        <span class="dot" style="background:var(--dgpu)"></span>
        <span class="nm">${esc((d.name || 'GPU').replace(/NVIDIA |GeForce |Laptop GPU|Graphics/g, '').trim() || 'GPU')}</span>
        <span class="val num">${gbText(d.usedMB, 1)}<span style="color:var(--ink-4);font-weight:600">/${gbText(d.totalMB, 0)}G</span></span>
      </div>` : ''}
      ${i ? `<div class="gpu-chip" title="${esc(i.name)}">
        <span class="dot" style="background:var(--igpu)"></span>
        <span class="nm">${esc((i.name || '核显').replace(/Intel\(R\) |\(R\)|Graphics/g, '').trim() || '核显')}</span>
        <span class="val num">${gbText(i.usedMB, 1)}<span style="color:var(--ink-4);font-weight:600">/${gbText(i.totalMB, 0)}G</span></span>
      </div>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="report" style="justify-content:center;margin-top:2px">${ico('download', 'ico xs')}导出报告</button>`;

    const p = PAGES[state.page];
    $('#pageTitle').textContent = p.title;
    $('#pageSub').textContent = p.sub;

    const actions = [];
    if (state.page === 'dashboard') {
      actions.push(`<button class="btn btn-ghost" data-act="measureQuick">${ico('play', 'ico sm')}立即实测</button>`);
      actions.push(`<button class="btn btn-primary" data-act="optimize">${ico('spark', 'ico sm')}一键优化</button>`);
    } else if (state.page === 'apps') {
      actions.push(`<button class="btn btn-ghost" data-act="addApp">${ico('folder', 'ico sm')}添加程序</button>`);
      actions.push(`<button class="btn btn-primary" data-act="optimize">${ico('spark', 'ico sm')}一键优化</button>`);
    } else if (state.page === 'insights') {
      actions.push(`<button class="btn btn-ghost" data-act="report">${ico('download', 'ico sm')}导出报告</button>`);
    } else {
      actions.push(`<button class="btn btn-ghost" data-act="refresh">${ico('refresh', 'ico sm')}刷新数据</button>`);
    }
    $('#topActions').innerHTML = actions.join('');
  }

  /* ── 概览 ─────────────────────────────────────────────── */
  function renderDashboard() {
    const d = adapter('dgpu');
    const i = adapter('igpu');
    const ins = insights();
    const sv = savings();
    const used = d ? d.usedMB : 0;
    const total = d ? d.totalMB : 0;
    const free = Math.max(0, total - used);
    const p1 = pct(used, total || 1);

    const pendingPct = pct(ins.pendingMB, total || 1);
    const steps = [
      { k: '待重启生效', v: ins.pendingMB, done: ins.pendingMB === 0, n: '1' },
      { k: '建议再迁移', v: ins.suggestMB, done: ins.suggestCount === 0, n: '2' },
      { k: '已实测释放', v: sv.totalFreedMB || 0, done: (sv.totalFreedMB || 0) > 0, n: '3' },
    ];

    const top = (snap().apps || []).filter((a) => a.category !== '系统')
      .sort((a, b) => (b.dgpuMB || 0) - (a.dgpuMB || 0)).slice(0, 6);
    const maxTop = Math.max(1, ...top.map((a) => a.dgpuMB || 0));

    return `
    <div class="page">
      <div class="grid g-hero">
        <section class="card glass hero" data-lens="1">
          <div class="hero-top">
            <span class="eyebrow">独显显存</span>
            <span class="tag dgpu">${esc((d && d.name) || '未识别独显')}</span>
            <span class="spacer" style="flex:1"></span>
            <span class="tag ${state.data && state.data.engine && state.data.engine.degraded ? 'warn' : 'igpu'}">
              ${state.data && state.data.engine && state.data.engine.degraded ? '降级采集' : '实时采集中'}
            </span>
          </div>
          <div class="hero-body">
            <div class="hero-left">
              <div class="hero-num">
                <div class="n num">${gbText(used, 1)}<span>GB</span></div>
                <div class="tot">/ ${gbText(total, 0)} GB</div>
              </div>
              <div class="hero-meta">
                <span>空闲 <b class="num" style="color:var(--igpu)">${gbText(free, 1)} GB</b></span>
                <span style="opacity:.4">·</span>
                <span>${(snap().apps || []).length} 个程序在用 GPU</span>
              </div>
              <div class="hero-bar">
                <div class="meter multi">
                  <i style="width:${p1 * 100}%;background:linear-gradient(90deg,#6E5CFF,#4F7CFA)"></i>
                  <i style="width:${Math.min(pendingPct, 1 - p1) * 100}%;background:linear-gradient(90deg,#F3B75A,#E8961A)"></i>
                </div>
                <div class="hero-legend">
                  <span><i style="background:linear-gradient(90deg,#6E5CFF,#4F7CFA)"></i>已占用</span>
                  <span><i style="background:#E8961A"></i>待释放 ${mbText(ins.pendingMB)}</span>
                  <span><i style="background:var(--track)"></i>空闲</span>
                </div>
              </div>
              <div class="hero-stats">
                <div class="hstat"><div class="k">可释放（待重启）</div><div class="v num">${gbText(ins.pendingMB, 2)}<small>GB</small></div></div>
                <div class="hstat"><div class="k">建议迁移预估</div><div class="v num">${gbText(ins.suggestMB, 2)}<small>GB</small></div></div>
                <div class="hstat"><div class="k">已实测释放</div><div class="v num" style="color:var(--igpu)">${gbText(sv.totalFreedMB || 0, 2)}<small>GB</small></div></div>
              </div>
              <div class="hero-actions">
                <button class="btn btn-primary" data-act="optimize">${ico('spark', 'ico sm')}一键智能优化</button>
                <button class="btn btn-ghost" data-act="goto" data-page="insights">${ico('chart', 'ico sm')}查看实测明细</button>
              </div>
            </div>
            <div class="ring" id="heroRing" style="--ring:${p1}"></div>
          </div>
        </section>

        <section class="card glass saving-card">
          <div class="card-head">
            <span class="card-title">释放收益</span>
            <span class="spacer"></span>
            <span class="tag ${(sv.totalFreedMB || 0) > 0 ? 'igpu' : ''}">${(sv.sessions || []).filter((s) => s.status === 'applied').length} 次实测</span>
          </div>
          <div class="saving-big">
            <div class="n num">${gbText(sv.totalFreedMB || 0, 2)}</div>
            <div class="u">GB 已实测释放</div>
          </div>
          <div class="saving-note">${(sv.totalFreedMB || 0) > 0
            ? '来自切换前后真实采样：进程重启后独显占用下降的部分才计入。'
            : '还没有实测记录。选几个程序跑一次「实测」，用数字确认到底腾出了多少显存。'}</div>
          <div class="saving-steps">
            ${steps.map((s) => `<div class="sstep ${s.done ? 'done' : ''}">
              <span class="i">${s.done ? '✓' : s.n}</span>
              <span>${s.k}</span>
              <span class="v num">${mbText(s.v)}</span>
            </div>`).join('')}
          </div>
          <div style="margin-top:auto;padding-top:14px">
            <button class="btn btn-ghost" data-act="goto" data-page="insights" style="width:100%;justify-content:center">
              ${ico('arrowUp', 'ico sm')}打开收益实测
            </button>
          </div>
        </section>
      </div>

      <div class="grid g-main">
        <section class="card glass">
          <div class="card-head">
            <span class="card-title">显存曲线</span>
            <span class="card-sub">独显 / 核显 实时占用</span>
            <span class="spacer"></span>
            <div class="seg" id="rangeSeg">
              ${[1, 5, 10, 30].map((m) => `<button data-range="${m}" class="${state.range === m ? 'on' : ''}">${m}分</button>`).join('')}
            </div>
          </div>
          <div class="chart-wrap">
            <canvas id="mainChart"></canvas>
            <div class="chart-tip" id="chartTip"></div>
          </div>
          <div class="legend" style="margin-top:10px">
            <span><i style="background:#5F4DFF"></i>独显 已用 ${mbText(used)}</span>
            <span><i style="background:#0EAF7E"></i>核显 已用 ${mbText(i ? i.usedMB : 0)}</span>
          </div>
        </section>

        <section class="card glass">
          <div class="card-head">
            <span class="card-title">占用 Top ${top.length}</span>
            <span class="card-sub">可迁移程序</span>
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" data-act="goto" data-page="apps">全部程序</button>
          </div>
          <div>
            ${top.length ? top.map((a) => `
              <div class="top-item">
                <span class="app-ico" style="width:26px;height:26px;border-radius:7px">${a.iconUrl ? `<img src="${esc(a.iconUrl)}" alt="">` : esc((a.name || '?').slice(0, 2).toUpperCase())}</span>
                <span class="nm">${esc(a.name)}</span>
                <span class="mb num">${mbText(a.dgpuMB || 0)}</span>
                <span class="bar-mini" style="width:66px"><i style="width:${pct(a.dgpuMB || 0, maxTop) * 100}%;background:linear-gradient(90deg,#8B7BFF,#5F4DFF)"></i></span>
              </div>`).join('') : '<div class="empty">暂无 GPU 占用进程</div>'}
          </div>
        </section>
      </div>

      ${(ins.suggestTop || []).length ? `
      <section class="card glass suggest">
        <div class="lead">
          <div class="t">还能再腾出 ${mbText(ins.suggestMB)}</div>
          <div class="d">${ins.suggestCount} 个后台程序适合走核显</div>
        </div>
        <div class="items">
          ${ins.suggestTop.slice(0, 4).map((a) => `
            <button class="pill" data-act="migrateOne" data-path="${esc(a.exePath)}" title="迁移到核显">
              <span class="nm">${esc(a.name)}</span>
              <span class="mb num">${mbText(a.dgpuMB)}</span>
              <span class="go">迁移</span>
            </button>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" data-act="optimize">全部优化</button>
      </section>` : ''}
    </div>`;
  }

  /* ── 应用调度 ─────────────────────────────────────────── */
  function prefSeg(a) {
    const pref = a.preference == null ? 0 : a.preference;
    return `<div class="seg" data-pref-for="${esc(a.exePath)}">
      <button data-pref="1" data-path="${esc(a.exePath)}" class="${pref === 1 ? 'on' : ''}">核显</button>
      <button data-pref="0" data-path="${esc(a.exePath)}" class="${pref === 0 ? 'on' : ''}">自动</button>
      <button data-pref="2" data-path="${esc(a.exePath)}" class="${pref === 2 ? 'on' : ''}">独显</button>
    </div>`;
  }

  function renderApps() {
    const list = appList();
    const all = snap().apps || [];
    // 条形图按当前筛选结果的量级归一，避免被系统进程的巨大提交量压扁
    const maxMB = Math.max(1, ...list.map((a) => a.dgpuMB || 0));
    const counts = {
      all: all.length,
      igpu: all.filter((a) => a.preference === 1).length,
      dgpu: all.filter((a) => a.preference === 2).length,
      auto: all.filter((a) => a.preference == null || a.preference === 0).length,
      pending: all.filter((a) => a.preference === 1 && (a.dgpuMB || 0) > 8).length,
    };
    const chips = [
      ['all', '全部', counts.all], ['igpu', '核显', counts.igpu], ['dgpu', '独显', counts.dgpu],
      ['auto', '自动', counts.auto], ['pending', '待生效', counts.pending],
    ];
    const selMB = list.filter((a) => state.selected.has(a.exePath)).reduce((s, a) => s + (a.dgpuMB || 0), 0);
    const selCount = state.selected.size;

    return `
    <div class="page">
      <div class="toolbar">
        <div class="search-wrap" style="width:236px">
          ${ico('search')}
          <input class="input" id="searchInput" placeholder="搜索程序名或路径" value="${esc(state.query)}" />
        </div>
        <div class="chip-row">
          ${chips.map(([k, label, n]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-filter="${k}">${label}<span class="n num">${n}</span></button>`).join('')}
        </div>
        <span style="flex:1"></span>
        <div class="seg">
          <button data-sort="mb" class="${state.sort === 'mb' ? 'on' : ''}">按占用</button>
          <button data-sort="name" class="${state.sort === 'name' ? 'on' : ''}">按名称</button>
        </div>
        <button class="btn btn-ghost btn-icon" data-act="refresh" title="刷新">${ico('refresh', 'ico sm')}</button>
      </div>

      <section class="card glass apps-card">
        <div class="app-row head">
          <span><span class="check" data-act="selectAll" title="全选"><svg viewBox="0 0 12 12"><path d="m2.4 6.2 2.4 2.4 4.8-5"/></svg></span></span>
          <span></span>
          <span>程序</span>
          <span style="text-align:right" title="Windows 逐进程计数器（提交量），系统进程会计入桌面缓冲">占用</span>
          <span></span>
          <span style="text-align:right">分配到</span><span></span>
        </div>
        <div class="apps-scroll">
          ${list.length ? list.map((a) => `
            <div class="app-row ${state.selected.has(a.exePath) ? 'sel' : ''}" data-row="${esc(a.exePath)}">
              <span class="check ${state.selected.has(a.exePath) ? 'on' : ''}" data-check="${esc(a.exePath)}">
                <svg viewBox="0 0 12 12"><path d="m2.4 6.2 2.4 2.4 4.8-5"/></svg>
              </span>
              <span class="app-ico">${a.iconUrl ? `<img src="${esc(a.iconUrl)}" alt="">` : esc((a.name || '?').slice(0, 2).toUpperCase())}</span>
              <span style="min-width:0">
                <div class="app-name">${esc(a.name)}
                  ${a.preference === 1 && (a.dgpuMB || 0) > 8 ? '<span class="tag warn" style="margin-left:6px">待重启</span>' : ''}
                </div>
                <div class="app-path">${esc(a.exePath || '')}</div>
              </span>
              <span class="app-mb num">${a.dgpuMB ? gbText(a.dgpuMB, 2) + '<small>GB</small>' : '<span style="color:var(--ink-4)">—</span>'}</span>
              <span class="bar-mini"><i style="width:${pct(a.dgpuMB || 0, maxMB) * 100}%;background:linear-gradient(90deg,#9C8DFF,#5F4DFF)"></i></span>
              ${prefSeg(a)}
              <button class="btn btn-ghost btn-icon btn-sm" data-act="rowMenu" data-path="${esc(a.exePath)}" title="更多">${ico('more', 'ico xs')}</button>
            </div>`).join('') : `<div class="empty">${ico('search')}<div>没有匹配的程序</div><div style="font-size:11px;opacity:.8">试试清空搜索，或点右上角「添加程序」</div></div>`}
        </div>
      </section>

      <div class="bulkbar ${selCount ? 'show' : ''}">
        <span class="txt">已选 <b>${selCount}</b> 项 · 预计释放 <b>${mbText(selMB)}</b></span>
        <button class="btn btn-primary btn-sm" data-act="bulkIgpu">迁移到核显</button>
        <button class="btn btn-ghost btn-sm" data-act="clearSel" style="color:#fff;background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2)">取消</button>
      </div>
    </div>`;
  }

  /* ── 收益实测 ─────────────────────────────────────────── */
  function renderInsights() {
    const ins = insights();
    const sv = savings();
    const m = state.measure || (state.data && state.data.measure) || { phase: 'idle', targets: [] };
    const applied = (sv.sessions || []).filter((s) => s.status === 'applied').slice().reverse();
    const d = adapter('dgpu');

    const phaseIdx = { idle: -1, baseline: 0, applying: 1, waiting: 1, measure: 2, done: 3, cancelled: -1 }[m.phase] ?? -1;
    const running = ['baseline', 'applying', 'waiting', 'measure'].includes(m.phase);

    const pick = (m.targets || []).length ? m.targets : (ins.suggestTop || []).slice(0, 3);
    const pickRows = (ins.suggestTop || []).slice(0, 6);

    const res = m.result;
    const beforeV = res ? res.baselineAvgMB : (m.liveBaselineMB || (d ? d.usedMB : 0));
    const afterV = res ? res.afterAvgMB : (m.liveAfterMB || 0);

    return `
    <div class="page">
      <div class="ins-grid">
        <section class="card glass">
          <div class="stat" style="background:none;border:0;box-shadow:none;padding:0">
            <div class="k">${ico('check', 'ico xs')}累计实测释放</div>
            <div class="v num" style="color:var(--igpu)">${gbText(sv.totalFreedMB || 0, 2)}<small>GB</small></div>
            <div class="d">${applied.length} 次完成的实测，全部来自重启前后采样</div>
          </div>
        </section>
        <section class="card glass">
          <div class="stat" style="background:none;border:0;box-shadow:none;padding:0">
            <div class="k">${ico('clock', 'ico xs')}待重启可释放</div>
            <div class="v num" style="color:var(--warn)">${gbText(ins.pendingMB, 2)}<small>GB</small></div>
            <div class="d">${ins.pendingCount} 个程序已设为核显，重启它们才会真正让出显存</div>
          </div>
        </section>
        <section class="card glass">
          <div class="stat" style="background:none;border:0;box-shadow:none;padding:0">
            <div class="k">${ico('spark', 'ico xs')}建议迁移预估</div>
            <div class="v num">${gbText(ins.suggestMB, 2)}<small>GB</small></div>
            <div class="d">${ins.suggestCount} 个可迁移程序，按当前占用求和</div>
          </div>
        </section>
      </div>

      <section class="card glass ab-card" data-lens="1">
        <div class="card-head" style="margin-bottom:0">
          <span class="card-title">A / B 实测</span>
          <span class="card-sub">切换前采样 → 写偏好 → 重启 → 切换后采样</span>
          <span class="spacer"></span>
          ${running
            ? `<button class="btn btn-ghost btn-sm" data-act="measureCancel">${ico('x', 'ico xs')}取消实测</button>`
            : `<button class="btn btn-primary btn-sm" data-act="measureStart">${ico('play', 'ico xs')}开始实测</button>`}
        </div>

        <div class="stepper">
          ${['基线采样', '写入核显偏好', '重启后采样', '结果'].map((t, idx) => `
            <div class="step ${phaseIdx === idx ? 'on' : phaseIdx > idx ? 'done' : ''}">
              <span class="dot">${phaseIdx > idx ? '✓' : idx + 1}</span><span>${t}</span>
            </div>
            ${idx < 3 ? '<span class="step-line"></span>' : ''}`).join('')}
        </div>

        ${running || res ? `
        <div class="ab-body">
          <div class="ab-panel">
            <div class="k">切换前 · 独显已用</div>
            <div class="v num">${gbText(beforeV, 2)}<small> GB</small></div>
            <div class="d" style="font-size:11px;color:var(--ink-3);margin-top:4px">${res ? res.baselineSeconds + ' 秒采样均值' : '实时均值'}</div>
          </div>
          <div class="ab-panel" style="background:linear-gradient(158deg,rgba(14,175,126,.1),rgba(14,175,126,.03));border-color:rgba(14,175,126,.2)">
            <div class="k">切换后 · 独显已用</div>
            <div class="v num">${res ? gbText(afterV, 2) : '—'}<small> ${res ? 'GB' : ''}</small></div>
            <div style="font-size:11px;color:var(--ink-3);margin-top:4px">${res ? (res.estimated ? '未检测到重启，按当前值估算' : res.afterSeconds + ' 秒采样均值') : '等待重启后采样'}</div>
          </div>
        </div>

        <div class="ab-progress">
          <div class="meter"><i style="width:${Math.round((m.progress || 0) * 100)}%;background:linear-gradient(90deg,#7A6BFF,#4F7CFA)"></i></div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11.5px;color:var(--ink-3)">
            <span>${esc(m.hint || '')}</span>
            <span style="flex:1"></span>
            ${res ? `<span class="tag ${res.freedMB > 0 ? 'igpu' : 'warn'}">净释放 ${mbText(res.freedMB)}</span><span class="tag">置信度 ${res.confidence === 'high' ? '高' : res.confidence === 'medium' ? '中' : res.confidence === 'low' ? '低' : '估算'}</span>` : ''}
          </div>
        </div>` : `
        <div class="ab-body">
          <div class="ab-panel">
            <div class="k">怎么测的</div>
            <p style="font-size:11.8px;color:var(--ink-2);line-height:1.7;margin-top:8px">
              先在 15 秒内记录独显已用显存均值，再把选中程序写成「节能 → 核显」。
              程序重启后 DirectX 才读新偏好，之后 15 秒再采样一次，两次均值之差就是这次释放量。
              期间其他程序波动会体现在「置信度」里。
            </p>
          </div>
          <div class="ab-panel">
            <div class="k">本次实测目标</div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
              ${pickRows.length ? pickRows.map((a) => `
                <label class="sheet-item" style="padding:4px 2px">
                  <span class="check ${(state.measurePick || new Set(pickRows.slice(0, 3).map((x) => x.exePath))).has(a.exePath) ? 'on' : ''}" data-pick="${esc(a.exePath)}">
                    <svg viewBox="0 0 12 12"><path d="m2.4 6.2 2.4 2.4 4.8-5"/></svg>
                  </span>
                  <span class="nm">${esc(a.name)}</span>
                  <span class="mb num">${mbText(a.dgpuMB)}</span>
                </label>`).join('') : '<div class="empty" style="padding:10px">当前没有可迁移的高占用程序</div>'}
            </div>
          </div>
        </div>`}
      </section>

      <div class="grid" style="grid-template-columns:1.45fr 1fr;margin-top:12px">
        <section class="card glass">
          <div class="card-head">
            <span class="card-title">实测记录</span>
            <span class="card-sub">只有完成的会话才计入累计</span>
            <span class="spacer"></span>
          </div>
          ${applied.length ? `
          <table class="tbl">
            <thead><tr><th>程序</th><th>切换前</th><th>切换后</th><th>释放</th><th>时间</th></tr></thead>
            <tbody>
              ${applied.slice(0, 10).map((s) => `<tr>
                <td>${esc(s.name || (s.exePath || '').split(/[\\\\/]/).pop())}</td>
                <td class="num">${mbText(s.beforeDgpuMB || 0)}</td>
                <td class="num">${mbText(s.afterDgpuMB || 0)}</td>
                <td class="num" style="color:var(--igpu);font-weight:700">${mbText(s.freedMB || 0)}</td>
                <td style="color:var(--ink-3)">${dateText(s.appliedAt || s.beforeAt)}</td>
              </tr>`).join('')}
            </tbody>
          </table>` : `<div class="empty">
              ${ico('clock')}
              <div>还没有完成的实测</div>
              <div style="font-size:11px;opacity:.85;max-width:280px">跑一次 A/B 实测，这里会出现可追溯的释放记录与置信度。</div>
              <button class="btn btn-primary btn-sm" data-act="measureStart" style="margin-top:6px">${ico('play', 'ico xs')}开始第一次实测</button>
            </div>`}
        </section>

        <section class="card glass">
          <div class="card-head"><span class="card-title">显存预算</span><span class="card-sub">目标占用</span></div>
          <p style="font-size:11.5px;color:var(--ink-3);line-height:1.65">
            我要在这张卡上跑一个需要 <b class="num" style="color:var(--ink)">${state.calcGB}</b> GB 显存的程序，现在还差多少？
          </p>
          <div class="calc-row">
            <input class="input num" id="calcInput" type="number" min="1" max="64" step="0.5" value="${state.calcGB}" />
            <span style="font-size:11.5px;color:var(--ink-3)">GB</span>
            <span style="flex:1"></span>
            <button class="btn btn-ghost btn-sm" data-act="calcPlan">看方案</button>
          </div>
          <div class="calc-out">
            ${(() => {
              const totalGB = totalGBOf(d);
              const freeGB = totalGB - gb(d ? d.usedMB : 0);
              const need = Math.max(0, state.calcGB - freeGB);
              return `<div class="big num">${need > 0 ? '还差 ' + need.toFixed(2) + ' GB' : '当前已够用'}</div>
                <div class="hint">${need > 0
                  ? `空闲 ${freeGB.toFixed(2)} GB。把下方推荐程序迁到核显，预计可再腾出 ${gbText(ins.suggestMB, 2)} GB${ins.suggestMB >= need * 1024 ? '，足够覆盖缺口。' : '，仍不够，建议关闭部分程序或降低画质/批次。'}`
                  : `空闲 ${freeGB.toFixed(2)} GB 已满足 ${state.calcGB} GB 需求，直接跑。`}</div>`;
            })()}
          </div>
        </section>
      </div>

      <section class="card glass" style="margin-top:12px;padding:14px 18px">
        <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:11.2px;color:var(--ink-3);line-height:1.7">
          <span style="display:flex;gap:6px;align-items:flex-start">${ico('info', 'ico xs')}
            <span><b style="color:var(--ink-2)">整卡口径</b>：独显总量/已用取自 NVML，和任务管理器一致。</span></span>
          <span style="display:flex;gap:6px;align-items:flex-start">${ico('info', 'ico xs')}
            <span><b style="color:var(--ink-2)">逐进程口径</b>：Windows 性能计数器报的是提交量，系统进程（如 dwm）会重复计入桌面缓冲，所以各程序相加可能大于整卡已用；释放量一律以实测为准。</span></span>
          <span style="display:flex;gap:6px;align-items:flex-start">${ico('info', 'ico xs')}
            <span><b style="color:var(--ink-2)">生效条件</b>：显卡偏好只在进程启动时读取，改完必须重启该程序。</span></span>
        </div>
      </section>
    </div>`;
  }

  function totalGBOf(d) { return d ? Math.round((d.totalMB || 0) / 1024) : 0; }

  /* ── 设置 ─────────────────────────────────────────────── */
  function renderSettings() {
    const s = settings();
    const e = (state.data && state.data.engine) || {};
    const cats = ['浏览器', '通讯', '办公', '下载', '影音', '游戏', '开发', '系统'];
    const picked = Array.isArray(s.autoCategories) ? s.autoCategories : [];
    return `
    <div class="page">
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <section class="card glass set-card">
          <div class="set-row">
            <div class="txt"><div class="t">主题</div><div class="d">液态玻璃在浅色下折射更明显，深色更适合夜间</div></div>
            <div class="seg" id="themeSeg">
              <button data-theme-set="light" class="${s.theme !== 'dark' ? 'on' : ''}">浅色</button>
              <button data-theme-set="dark" class="${s.theme === 'dark' ? 'on' : ''}">深色</button>
            </div>
          </div>
          <div class="set-row">
            <div class="txt"><div class="t">动效</div><div class="d">关闭后停止背景极光漂移与页面转场，省一点 GPU</div></div>
            <button class="toggle ${s.reduceMotion ? '' : 'on'}" data-act="toggleMotion"></button>
          </div>
          <div class="set-row">
            <div class="txt"><div class="t">采样间隔</div><div class="d">越短越灵敏，但会略微增加 CPU/GPU 计数开销</div></div>
            <div class="seg" id="intervalSeg">
              ${[1000, 2000, 5000].map((ms) => `<button data-interval="${ms}" class="${Number(s.interval) === ms ? 'on' : ''}">${ms / 1000}s</button>`).join('')}
            </div>
          </div>
          <div class="set-row">
            <div class="txt"><div class="t">数据目录</div><div class="d" style="font-size:10.5px">${esc((state.data && state.data.dataDir) || s.dataDir || '')}</div></div>
            <button class="btn btn-ghost btn-sm" data-act="openData">${ico('folder', 'ico xs')}打开</button>
          </div>
        </section>

        <section class="card glass set-card">
          <div class="set-row">
            <div class="txt"><div class="t">自动分流</div><div class="d">新出现的程序若属于勾选分类且推荐核显，自动写入偏好（只对从未手动设置过的程序生效）</div></div>
            <button class="toggle ${s.autoRules ? 'on' : ''}" data-act="toggleAuto"></button>
          </div>
          <div class="set-row" style="display:block">
            <div class="t" style="margin-bottom:8px">参与自动分类</div>
            <div class="chip-row">
              ${cats.map((c) => `<button class="chip ${picked.includes(c) ? 'on' : ''}" data-cat="${esc(c)}">${c}</button>`).join('')}
            </div>
            <div class="d" style="margin-top:10px">系统进程（dwm、csrss 等）永远不会被自动处理。</div>
          </div>
        </section>
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:12px">
        <section class="card glass">
          <div class="card-head"><span class="card-title">采集引擎</span><span class="spacer"></span>
            <span class="tag ${e.degraded ? 'warn' : 'igpu'}">${e.degraded ? '降级' : '正常'}</span></div>
          <div class="kv">
            <span class="k">数据源</span><span class="v">${esc(e.mode || '—')}</span>
            <span class="k">后端模式</span><span class="v">${esc(e.backend || '—')}</span>
            <span class="k">单次采样耗时</span><span class="v">${e.sampleMs != null ? e.sampleMs + ' ms' : '—'}</span>
            <span class="k">计数器数量</span><span class="v">${e.counters || 0}</span>
            <span class="k">nvml</span><span class="v">${e.nvidiaSmi ? '已连接（总量/已用为准）' : '未连接（退回计数器）'}</span>
            <span class="k">常驻进程 PID</span><span class="v">${e.workerPid || '—'}</span>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" data-act="openGraphics">${ico('arrowUp', 'ico xs')}Windows 图形设置</button>
            <button class="btn btn-ghost btn-sm" data-act="report">${ico('download', 'ico xs')}导出报告</button>
          </div>
        </section>

        <section class="card glass">
          <div class="card-head"><span class="card-title">关于</span></div>
          <div style="display:flex;align-items:center;gap:14px">
            <img src="../assets/icons/icon-128.png" alt="" style="width:56px;height:56px;border-radius:14px;box-shadow:0 10px 24px -10px rgba(60,50,160,.6)" />
            <div>
              <div style="font-size:14px;font-weight:700">GPU 调度管理器</div>
              <div style="font-size:11.5px;color:var(--ink-3);margin-top:3px">v${esc((state.data && state.data.version) || '3.0.0')} · Electron</div>
            </div>
          </div>
          <p style="font-size:11.5px;color:var(--ink-3);line-height:1.75;margin-top:14px">
            通过 Windows 显卡首选项（HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences）把程序调度到核显，
            并用性能计数器逐进程测量真实显存，切换前后的采样差值即释放量。
          </p>
          <div class="footer-note">把不用的程序交给核显 · 把独显留给真正需要它的程序</div>
        </section>
      </div>
    </div>`;
  }

  /* ── 主渲染 ───────────────────────────────────────────── */
  function render() {
    if (!state.data) {
      view.innerHTML = `<div class="empty" style="height:60vh">${ico('cpu')}<div>正在读取显卡数据…</div></div>`;
      return;
    }
    renderShell();
    const st = view.scrollTop;
    const html = state.page === 'dashboard' ? renderDashboard()
      : state.page === 'apps' ? renderApps()
        : state.page === 'insights' ? renderInsights()
          : renderSettings();
    view.innerHTML = html;
    view.scrollTop = st;
    if (state.animate) {
      const p = view.firstElementChild;
      if (p) { p.classList.add('page'); }
      state.animate = false;
    }
    if (state.page === 'dashboard') drawChart();
    if (state.page === 'dashboard') drawHeroRing();
  }

  function drawHeroRing() {
    const host = $('#heroRing');
    if (!host) return;
    const d = adapter('dgpu');
    const used = d ? d.usedMB : 0;
    const total = d ? d.totalMB : 0;
    window.Charts.ring(host, {
      size: 148,
      stroke: 12,
      pct: pct(used, total || 1),
      color: 'url(#none)',
      center: `<div class="big num">${Math.round(pct(used, total || 1) * 100)}<span>%</span></div><div class="cap">已占用</div>`,
    });
    const fg = host.querySelector('.ring-fg');
    if (fg) {
      fg.setAttribute('stroke', '#6E5CFF');
      fg.style.filter = 'drop-shadow(0 0 6px rgba(110,92,255,.45))';
    }
  }

  function chartPoints() {
    const from = Date.now() - state.range * 60 * 1000;
    return state.history.filter((p) => p.t >= from);
  }

  function drawChart() {
    const canvas = $('#mainChart');
    if (!canvas) return;
    const pts = chartPoints();
    const geo = window.Charts.area(canvas, { points: pts, hover: state.hover });
    canvas._geo = geo;
    canvas._pts = pts;
  }

  /* ── 交互 ─────────────────────────────────────────────── */
  const viewClick = async (e) => {
    const navEl = e.target.closest('[data-nav]');
    if (navEl) { state.page = navEl.dataset.nav; state.animate = true; render(); return; }

    const goto = e.target.closest('[data-act="goto"]');
    if (goto) { state.page = goto.dataset.page; state.animate = true; render(); return; }

    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn) { state.range = Number(rangeBtn.dataset.range); render(); return; }

    const filt = e.target.closest('[data-filter]');
    if (filt) { state.filter = filt.dataset.filter; render(); return; }

    const sort = e.target.closest('[data-sort]');
    if (sort) { state.sort = sort.dataset.sort; render(); return; }

    const themeBtn = e.target.closest('[data-theme-set]');
    if (themeBtn) {
      const t = themeBtn.dataset.themeSet;
      document.documentElement.dataset.theme = t;
      await api.setSettings({ theme: t });
      state.data.settings.theme = t;
      render();
      return;
    }

    const intervalBtn = e.target.closest('[data-interval]');
    if (intervalBtn) {
      const ms = Number(intervalBtn.dataset.interval);
      await api.setSettings({ interval: ms });
      state.data.settings.interval = ms;
      toast('采样间隔已切换为 ' + ms / 1000 + ' 秒');
      render();
      return;
    }

    const cat = e.target.closest('[data-cat]');
    if (cat) {
      const c = cat.dataset.cat;
      const cur = new Set(state.data.settings.autoCategories || []);
      if (cur.has(c)) cur.delete(c); else cur.add(c);
      await api.setSettings({ autoCategories: [...cur] });
      state.data.settings.autoCategories = [...cur];
      render();
      return;
    }

    const prefBtn = e.target.closest('[data-pref]');
    if (prefBtn) {
      const p = Number(prefBtn.dataset.pref);
      const path = prefBtn.dataset.path;
      if (!path) { toast('读不到该进程的可执行路径，无法写入显卡偏好', 'err'); return; }
      const app = (snap().apps || []).find((a) => a.exePath === path);
      const before = app ? Math.round(app.dgpuMB || 0) : 0;
      prefBtn.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === prefBtn));
      const r = p === 0 ? await api.restoreDefault(path) : await api.setPreference(path, p);
      if (r && r.ok) {
        if (p === 1 && before > 8) toast(`${app ? app.name : '程序'} 已设为核显 · 重启后预计释放 ${mbText(before)}`, 'warn', 4200);
        else toast(p === 1 ? '已设为核显' : p === 2 ? '已设为独显' : '已恢复系统默认');
        await refresh(true);
      } else {
        toast((r && r.error) || '写入失败，请用管理员身份运行', 'err');
        render();
      }
      return;
    }

    const check = e.target.closest('[data-check]');
    if (check) {
      const p = check.dataset.check;
      if (state.selected.has(p)) state.selected.delete(p); else state.selected.add(p);
      render();
      return;
    }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;

    if (a === 'refresh') { await refresh(); toast('已刷新'); return; }
    if (a === 'clearSel') { state.selected.clear(); render(); return; }
    if (a === 'selectAll') {
      const list = appList();
      const allOn = list.every((x) => state.selected.has(x.exePath));
      if (allOn) list.forEach((x) => state.selected.delete(x.exePath));
      else list.forEach((x) => state.selected.add(x.exePath));
      render();
      return;
    }
    if (a === 'addApp') {
      const r = await api.addApp();
      if (r && r.ok) { toast('已添加 ' + r.name); await refresh(true); }
      return;
    }
    if (a === 'openData') { api.openDataDir(); return; }
    if (a === 'openGraphics') { api.openGraphicsSettings(); return; }
    if (a === 'report') {
      const r = await api.exportReport();
      if (r && r.ok) toast('报告已生成：' + r.file.split('\\').pop());
      else toast('导出失败：' + ((r && r.error) || '未知错误'), 'err');
      return;
    }
    if (a === 'toggleMotion') {
      const next = !state.data.settings.reduceMotion;
      await api.setSettings({ reduceMotion: next });
      state.data.settings.reduceMotion = next;
      document.documentElement.dataset.motion = next ? 'off' : 'on';
      render();
      return;
    }
    if (a === 'toggleAuto') {
      const next = !state.data.settings.autoRules;
      await api.setSettings({ autoRules: next });
      state.data.settings.autoRules = next;
      toast(next ? '自动分流已开启：新程序按分类自动走核显' : '自动分流已关闭');
      render();
      return;
    }
    if (a === 'migrateOne') {
      const path = act.dataset.path;
      const app = (snap().apps || []).find((x) => x.exePath === path);
      act.disabled = true;
      const r = await api.setPreference(path, 1);
      await refresh(true);
      toast(r && r.ok ? `${app ? app.name : '程序'} 已设为核显 · 重启后释放 ${mbText(app ? app.dgpuMB : 0)}` : '设置失败', r && r.ok ? 'warn' : 'err', 4200);
      return;
    }
    if (a === 'bulkIgpu') {
      const paths = [...state.selected];
      if (!paths.length) return;
      const est = (snap().apps || []).filter((x) => state.selected.has(x.exePath)).reduce((s, x) => s + (x.dgpuMB || 0), 0);
      act.disabled = true;
      const r = await api.setBulk(paths, 1);
      state.selected.clear();
      await refresh(true);
      toast(`已把 ${(r && r.count) || paths.length} 个程序设为核显 · 重启后预计释放 ${mbText(est)}`, 'warn', 4600);
      return;
    }
    if (a === 'rowMenu') {
      const path = act.dataset.path;
      const app = (snap().apps || []).find((x) => x.exePath === path);
      if (!app) return;
      openSheet({
        title: app.name,
        sub: `<span style="font-size:11px;color:var(--ink-3);word-break:break-all">${esc(app.exePath)}</span>`,
        body: `<div class="kv" style="margin-top:14px">
            <span class="k">独显占用</span><span class="v">${mbText(app.dgpuMB || 0)}</span>
            <span class="k">当前策略</span><span class="v">${app.preference === 1 ? '核显' : app.preference === 2 ? '独显' : '系统默认'}</span>
            <span class="k">分类</span><span class="v">${esc(app.category || '未分类')}</span>
            <span class="k">进程数</span><span class="v">${(app.pids || []).length}</span>
          </div>`,
        actions: `
          <button class="btn btn-ghost" data-sheet-close>关闭</button>
          <button class="btn btn-ghost" data-sheet-act="reveal">打开位置</button>
          <button class="btn btn-primary" data-sheet-act="restart">${app.preference === 1 ? '重启以生效' : '重启程序'}</button>`,
      });
      const sheet = sheetLayer.querySelector('.sheet');
      sheet.querySelector('[data-sheet-act="reveal"]').addEventListener('click', () => { api.revealInExplorer(path); closeSheet(); });
      sheet.querySelector('[data-sheet-act="restart"]').addEventListener('click', async () => {
        const r = await api.restartApp(path, app.pids || []);
        closeSheet();
        toast(r && r.ok ? '已重启 ' + app.name : '重启失败', r && r.ok ? 'ok' : 'err');
        setTimeout(() => refresh(true), 1500);
      });
      return;
    }
    if (a === 'optimize') {
      act.disabled = true;
      const list = await api.smartOptimize();
      act.disabled = false;
      if (!list || !list.length) { toast('没有可优化的程序了', 'warn'); return; }
      const total = list.reduce((s, x) => s + x.estMB, 0);
      openSheet({
        title: '一键智能优化',
        sub: '按「核显够用」规则挑出后台程序，全部切到核显。重启后才会真正释放显存。',
        body: `<div class="sheet-list">
            ${list.slice(0, 20).map((x) => `<label class="sheet-item">
              <span class="check on" data-opt="${esc(x.exePath)}"><svg viewBox="0 0 12 12"><path d="m2.4 6.2 2.4 2.4 4.8-5"/></svg></span>
              <span class="nm">${esc(x.name)}</span><span class="mb num">${mbText(x.estMB)}</span>
            </label>`).join('')}
          </div>
          <div class="sheet-total"><span>预计释放合计</span><b class="num">${mbText(total)}</b></div>`,
        actions: `<button class="btn btn-ghost" data-sheet-close>取消</button>
          <button class="btn btn-primary" data-sheet-act="apply">应用 ${Math.min(list.length, 20)} 项</button>`,
      });
      const sheet = sheetLayer.querySelector('.sheet');
      sheet.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('click', () => el.classList.toggle('on')));
      sheet.querySelector('[data-sheet-act="apply"]').addEventListener('click', async () => {
        const paths = [...sheet.querySelectorAll('[data-opt].on')].map((el) => el.dataset.opt);
        if (!paths.length) { closeSheet(); return; }
        closeSheet();
        const r = await api.setBulk(paths, 1);
        await refresh(true);
        toast(`已优化 ${(r && r.count) || paths.length} 个程序 · 重启后释放`, 'warn', 4600);
      });
      return;
    }
    if (a === 'measureStart') {
      const picked = [...(state.measurePick || new Set())];
      let targets = picked;
      if (!targets.length) {
        targets = (insights().suggestTop || []).slice(0, 3).map((x) => x.exePath);
      }
      if (!targets.length) { toast('没有可实测的目标，先在应用调度里选择程序', 'warn'); return; }
      const r = await api.startMeasure({ exePaths: targets, baselineMs: 15000, afterMs: 15000 });
      if (r && r.error) toast(r.error, 'err');
      else { toast('基线采样开始，约 15 秒后写入核显偏好', 'ok'); state.page = 'insights'; render(); }
      return;
    }
    if (a === 'measureQuick') {
      state.page = 'insights';
      state.animate = true;
      render();
      return;
    }
    if (a === 'measureCancel') { await api.cancelMeasure(); toast('已取消实测', 'warn'); return; }
    if (a === 'calcPlan') {
      const v = Number($('#calcInput') && $('#calcInput').value) || state.calcGB;
      state.calcGB = v;
      const need = Math.max(0, v * 1024 - (insights().suggestMB + (adapter('dgpu') ? Math.max(0, adapter('dgpu').totalMB - adapter('dgpu').usedMB) : 0)));
      const picks = (snap().apps || []).filter((a) => a.category !== '系统' && a.recommended === 1 && a.preference !== 1)
        .sort((a, b) => (b.dgpuMB || 0) - (a.dgpuMB || 0));
      let acc = 0; const chosen = [];
      for (const p of picks) { if (acc >= need) break; acc += p.dgpuMB || 0; chosen.push(p); }
      openSheet({
        title: `跑 ${v} GB 目标的方案`,
        sub: '按当前占用从大到小贪心挑选，实际释放量以重启后的实测为准。',
        body: chosen.length ? `<div class="sheet-list">
            ${chosen.map((p) => `<div class="sheet-item">
              <span class="nm">${esc(p.name)}</span>
              <span class="tag ${p.preference === 1 ? 'warn' : ''}">${p.preference === 1 ? '待重启' : p.category || ''}</span>
              <span class="mb num">${mbText(p.dgpuMB || 0)}</span>
            </div>`).join('')}
          </div>
          <div class="sheet-total"><span>可腾出合计</span><b class="num">${mbText(acc)}</b></div>`
          : '<div class="empty">当前已经够用，不需要迁移</div>',
        actions: chosen.length
          ? `<button class="btn btn-ghost" data-sheet-close>关闭</button>
             <button class="btn btn-primary" data-sheet-act="apply">迁移这 ${chosen.length} 个</button>`
          : '<button class="btn btn-ghost" data-sheet-close>好</button>',
      });
      const applyBtn = sheetLayer.querySelector('[data-sheet-act="apply"]');
      if (applyBtn) applyBtn.addEventListener('click', async () => {
        const paths = chosen.map((p) => p.exePath);
        closeSheet();
        const r = await api.setBulk(paths, 1);
        await refresh(true);
        toast(`已迁移 ${(r && r.count) || paths.length} 个程序，重启后生效`, 'warn', 4200);
      });
      return;
    }
  };

  // 事件委托挂到 document：侧边导航在 #view 之外，必须一起接管
  document.addEventListener('click', viewClick);

  // 搜索输入
  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchInput') {
      state.query = e.target.value;
      clearTimeout(window.__qTimer);
      window.__qTimer = setTimeout(() => {
        const pos = e.target.selectionStart;
        render();
        const el = $('#searchInput');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      }, 160);
    }
    if (e.target.id === 'calcInput') {
      state.calcGB = Number(e.target.value) || 0;
    }
  });

  // 图表 hover
  view.addEventListener('mousemove', (e) => {
    const canvas = e.target.closest('#mainChart');
    if (!canvas || !canvas._geo) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = canvas._geo.indexAt(x);
    const pts = canvas._pts || [];
    if (!pts[idx]) return;
    state.hover = idx;
    drawChart();
    const tip = $('#chartTip');
    if (tip) {
      const p = pts[idx];
      tip.style.opacity = 1;
      tip.style.left = Math.min(Math.max(x, 60), rect.width - 60) + 'px';
      tip.style.top = '34px';
      tip.innerHTML = `<div style="opacity:.7;margin-bottom:2px">${timeText(p.t)}</div>
        <div class="row"><i style="background:#7A6BFF"></i>独显 <b>${mbText(p.d)}</b></div>
        <div class="row"><i style="background:#0EAF7E"></i>核显 <b>${mbText(p.i)}</b></div>`;
    }
  });
  view.addEventListener('mouseleave', () => {
    if (state.hover == null) return;
    state.hover = null;
    const tip = $('#chartTip');
    if (tip) tip.style.opacity = 0;
    if (state.page === 'dashboard') drawChart();
  });

  // 选中实测目标
  document.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const p = pick.dataset.pick;
      if (!state.measurePick) state.measurePick = new Set();
      if (state.measurePick.has(p)) state.measurePick.delete(p); else state.measurePick.add(p);
      render();
    }
  });

  // 窗口按钮
  $('#winMin').addEventListener('click', () => api.minimize());
  $('#winMax').addEventListener('click', () => api.maximize());
  $('#winClose').addEventListener('click', () => api.close());

  // 指针高光：让玻璃的镜面反射跟着鼠标走
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest('.glass');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  }, { passive: true });

  /* ── 数据刷新 ─────────────────────────────────────────── */
  async function refresh(fromAction) {
    const d = await api.getState();
    applyData(d, !fromAction);
  }

  function applyData(d, full) {
    if (!d) return;
    state.data = d;
    state.measure = d.measure || state.measure;
    if (full) {
      state.history = [];
      api.getHistory(30).then((h) => {
        if (!Array.isArray(h)) return;
        state.history = h.map((x) => ({ t: x.ts || x.t, d: x.dgpuUsedMB != null ? x.dgpuUsedMB : x.d, i: x.igpuUsedMB != null ? x.igpuUsedMB : x.i }))
          .filter((x) => x.t);
        if (state.page === 'dashboard') drawChart();
      });
    }
    const t = (d.snapshot && d.snapshot.ts) || Date.now();
    const tot = (d.snapshot && d.snapshot.totals) || {};
    if (!state.history.length || state.history[state.history.length - 1].t !== t) {
      state.history.push({ t, d: tot.dgpuUsedMB || 0, i: tot.igpuUsedMB || 0 });
      if (state.history.length > 3000) state.history.splice(0, state.history.length - 3000);
    }
    document.documentElement.dataset.theme = (d.settings && d.settings.theme) === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.motion = (d.settings && d.settings.reduceMotion) ? 'off' : 'on';
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      renderShell();
    } else {
      render();
    }
  }

  /* ── 启动 ─────────────────────────────────────────────── */
  api.onTick((payload) => applyData(payload, false));
  api.onMeasure((m) => {
    const prevPhase = state.measure && state.measure.phase;
    state.measure = m;
    if (m.phase === 'done' && prevPhase !== 'done' && m.result) {
      const r = m.result;
      toast(`实测完成：净释放 ${mbText(r.freedMB)}（置信度 ${r.confidence === 'high' ? '高' : r.confidence === 'medium' ? '中' : r.confidence === 'low' ? '低' : '估算'}）`, r.freedMB > 0 ? 'ok' : 'warn', 5600);
      refresh(true);
    } else if (m.phase === 'waiting' && prevPhase !== 'waiting') {
      toast('偏好已写入，请重启被标记的程序', 'warn', 5200);
    }
    if (state.page === 'insights') render();
    else renderShell();
  });
  api.onAutoApplied((p) => toast(`自动分流：${p.name} → 核显`, 'ok'));

  (async () => {
    try {
      // 支持 ?page=apps 直达（打包截图 / 快捷方式用）
      const q = new URLSearchParams(location.search).get('page');
      if (q && PAGES[q]) { state.page = q; state.animate = false; }
      const d = await api.getState();
      applyData(d, true);
    } catch (err) {
      view.innerHTML = `<div class="empty" style="height:60vh">${ico('warn')}<div>读取失败：${esc(err.message)}</div></div>`;
    }
  })();
})();
