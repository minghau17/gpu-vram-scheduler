'use strict';
/**
 * savings.js — 释放量化（核心）：把「切到核显」产生多少真实显存释放做成可验证的状态机。
 *
 * 流程（对 SPEC 的忠实实现）：
 *   1. setPreference(exe, 1) 时调用 begin()：记录 beforeDgpuMB（切换前该应用在独显上的
 *      Dedicated Usage 之和）、切换前 pid 列表、时间戳，状态 pending，deadline = now + 5min。
 *   2. 每个 tick 调 observe(snapshot)：
 *        - 目标 exe 的 pid 列表相对切换前发生变化（旧 pid 消失 / 新 pid 出现 / 进程重新启动）
 *          记为一次 restart；重启后继续观察，直到 dgpuMB 下降或 deadline 到期。
 *        - dgpuMB 下降 -> status=applied, freedMB = max(0, beforeDgpuMB - afterDgpuMB)，
 *          写入 beforeAt/afterAt/afterDgpuMB 作为「证据」，累计进 totalFreedMB（按 session 求和，幂等）。
 *        - 5 分钟内没重启（或重启了但显存没降）-> status=needsRestart（提示用户重启程序才生效）。
 *   3. 用户改回 0/2 / restoreDefault -> cancel()，session 标记 cancelled，不计入释放。
 *
 * 所有 session 持久化在 <dataDir>/state.json 的 savings 字段里（最多保留 300 条）。
 * now 可注入，便于 test.js 用假时钟做单测。
 */
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;   // SPEC: 5 分钟未重启 -> needsRestart
const RESTART_SETTLE_MS = 1200;              // 重启后等一个采样周期再判定，避免读到刚启动的高值
const MAX_SESSIONS = 300;

function normPath(p) {
  return String(p || '').toLowerCase();
}

class SavingsEngine {
  /**
   * @param {object} opts { store, now }
   *   store: object with getState()/setState()/save() (see store.js)
   */
  constructor(opts) {
    const o = opts || {};
    this.store = o.store || null;
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();
    this._sessions = [];
    this._totalFreedMB = 0;
    this._dirty = false;
    this._lastPersistAt = 0;
    this._load();
  }

  _load() {
    if (!this.store) return;
    try {
      const state = this.store.getState() || {};
      const savings = state.savings || {};
      this._sessions = Array.isArray(savings.sessions) ? savings.sessions.map((s) => ({ ...s })) : [];
      // recompute (do not trust a stale total)
      this._totalFreedMB = this._recomputeTotal();
    } catch (_) {
      this._sessions = [];
      this._totalFreedMB = 0;
    }
  }

  _recomputeTotal() {
    return this._sessions
      .filter((s) => s.status === 'applied')
      .reduce((sum, s) => sum + (Number(s.freedMB) || 0), 0);
  }

  _persist(force) {
    if (!this.store) return;
    const now = this.now();
    if (!force && now - this._lastPersistAt < 1000) { this._dirty = true; return; }
    try {
      const state = this.store.getState() || {};
      state.savings = {
        totalFreedMB: this._totalFreedMB,
        sessions: this._sessions.slice(-MAX_SESSIONS),
        updatedAt: now,
      };
      this.store.setState(state);
      this.store.save();
      this._lastPersistAt = now;
      this._dirty = false;
    } catch (_) { /* persistence must never break polling */ }
  }

  flush() { if (this._dirty) this._persist(true); else this._persist(true); }

  /**
   * 记录一次「已写入注册表」的切换，开始量化。
   * @param {object} p { exePath, name, pref, beforeDgpuMB, pids, beforeAt, prefEvidence }
   */
  begin(p) {
    const now = this.now();
    const exePath = p.exePath || '';
    // 同一 exe 已有未完成的 session：先取消，避免重复计量
    for (const s of this._sessions) {
      if (s.status === 'pending' && normPath(s.exePath) === normPath(exePath)) {
        s.status = 'cancelled';
        s.cancelledAt = now;
      }
    }
    const session = {
      id: 'swap_' + now.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36),
      exePath,
      name: p.name || '',
      pref: p.pref,
      beforeDgpuMB: Math.max(0, Math.round(Number(p.beforeDgpuMB) || 0)),
      beforePids: Array.isArray(p.pids) ? p.pids.slice() : [],
      beforeAt: p.beforeAt || now,
      startedAt: now,
      deadlineAt: now + (p.deadlineMs || DEFAULT_DEADLINE_MS),
      status: 'pending',
      restarts: 0,
      restartedAt: null,
      afterDgpuMB: null,
      freedMB: 0,
      afterAt: null,
      lastSeenPids: Array.isArray(p.pids) ? p.pids.slice() : [],
      prefEvidence: p.prefEvidence || null,   // {before:{raw,pref}, after:{raw,pref}}
    };
    this._sessions.push(session);
    if (this._sessions.length > MAX_SESSIONS) this._sessions = this._sessions.slice(-MAX_SESSIONS);
    this._persist(true);
    return session;
  }

  /** 用户把偏好改回去了：撤销 pending session。 */
  cancel(exePath, reason) {
    const now = this.now();
    let changed = false;
    for (const s of this._sessions) {
      if (s.status === 'pending' && normPath(s.exePath) === normPath(exePath)) {
        s.status = 'cancelled';
        s.cancelledAt = now;
        s.cancelReason = reason || 'preference changed';
        changed = true;
      }
    }
    if (changed) this._persist(true);
    return changed;
  }

  /**
   * 每个 tick 调用。snapshot 需要包含 apps（每个 app 有 exePath/dgpuMB/pids/running）。
   * @returns {{applied:object[], needsRestart:object[], changed:boolean}}
   */
  observe(snapshot) {
    const now = this.now();
    const applied = [];
    const needsRestart = [];
    let changed = false;
    if (!snapshot || !Array.isArray(snapshot.apps)) return { applied, needsRestart, changed };

    const byPath = new Map();
    for (const app of snapshot.apps) {
      if (app && app.exePath) byPath.set(normPath(app.exePath), app);
    }

    for (const s of this._sessions) {
      if (s.status !== 'pending') continue;
      const app = byPath.get(normPath(s.exePath));
      const pids = app && Array.isArray(app.pids) ? app.pids.slice() : [];

      if (app && app.running) {
        const before = new Set(s.beforePids);
        const grew = pids.some((pid) => !before.has(pid));
        const shrank = s.beforePids.length > 0 && s.beforePids.some((pid) => !pids.includes(pid));
        const changedPids = grew || shrank || (s.beforePids.length === 0 && pids.length > 0);
        if (changedPids && !s.restartedAt) {
          s.restartedAt = now;
          s.restarts = (s.restarts || 0) + 1;
          changed = true;
        }
        // 进程重启后（或首次出现）再观察显存是否下降
        const sinceRestart = s.restartedAt ? now - s.restartedAt : 0;
        const observedLongEnough = !s.restartedAt ? false : sinceRestart >= RESTART_SETTLE_MS;
        const nowDgpuMB = Math.max(0, Math.round(Number(app.dgpuMB) || 0));
        if (s.restartedAt && observedLongEnough && nowDgpuMB < s.beforeDgpuMB) {
          const freed = Math.max(0, s.beforeDgpuMB - nowDgpuMB);
          s.status = 'applied';
          s.afterDgpuMB = nowDgpuMB;
          s.freedMB = freed;
          s.afterAt = now;
          s.lastSeenPids = pids;
          this._totalFreedMB = this._recomputeTotal();
          applied.push(s);
          changed = true;
        } else if (app.running) {
          s.lastSeenPids = pids;
        }
      } else if (app && !app.running) {
        // 进程已退出：等它重新出现，仍受 deadline 约束
        s.lastSeenPids = [];
      }

      if (s.status === 'pending' && now >= s.deadlineAt) {
        s.status = 'needsRestart';
        s.checkedAt = now;
        s.reason = s.restartedAt
          ? '进程已重启但显存未下降，可能仍在使用独显'
          : '5 分钟内进程未重启，重启后生效';
        needsRestart.push(s);
        changed = true;
      }
    }

    if (changed) this._persist(false);
    return { applied, needsRestart, changed };
  }

  /** SPEC getSavings() 的返回体（含证据字段，UI 用）。 */
  getSavings(opts) {
    const o = opts || {};
    const limit = Number(o.limit) || 40;
    const sessions = this._sessions.slice(-limit).reverse();
    const counts = { pending: 0, applied: 0, needsRestart: 0, cancelled: 0 };
    for (const s of this._sessions) {
      if (counts[s.status] != null) counts[s.status]++;
    }
    const appliedSessions = this._sessions.filter((s) => s.status === 'applied');
    const last = appliedSessions[appliedSessions.length - 1] || null;
    return {
      totalFreedMB: Math.round(this._totalFreedMB),
      appliedCount: counts.applied,
      pendingCount: counts.pending,
      needsRestartCount: counts.needsRestart,
      cancelledCount: counts.cancelled,
      lastFreedMB: last ? last.freedMB : 0,
      lastFreedAt: last ? last.afterAt : null,
      lastApplied: last ? this._publicSession(last) : null,
      sessions: sessions.map((s) => this._publicSession(s)),
      updatedAt: this.now(),
    };
  }

  _publicSession(s) {
    const pidBefore = Array.isArray(s.beforePids) ? s.beforePids.slice() : [];
    const pidAfter = Array.isArray(s.lastSeenPids) ? s.lastSeenPids.slice() : [];
    // UI 用的「事件时间」：applied=完成时间，needsRestart=判定时间，cancelled=取消时间，pending=开始时间
    const at = s.status === 'applied' ? s.afterAt
      : s.status === 'needsRestart' ? (s.checkedAt || s.deadlineAt)
        : s.status === 'cancelled' ? s.cancelledAt
          : s.startedAt;
    return {
      id: s.id,
      exePath: s.exePath,
      name: s.name,
      pref: s.pref,
      status: s.status,
      // UI 展示"切换前→切换后→释放"所需的字段（Lead 的映射按这些取值）
      at,
      beforeDgpuMB: s.beforeDgpuMB,
      afterDgpuMB: s.afterDgpuMB,
      freedMB: s.freedMB,
      beforeAt: s.beforeAt,
      afterAt: s.afterAt,
      pidBefore,
      pidAfter,
      restarts: s.restarts || 0,
      deadlineAt: s.deadlineAt,
      reason: s.reason || null,
      prefEvidence: s.prefEvidence || null,
      // 供 UI 直接展示的「证据」文案
      evidence: s.status === 'applied'
        ? `切换前 ${s.beforeDgpuMB}MB（${new Date(s.beforeAt).toLocaleTimeString()}）→ 重启后 ${s.afterDgpuMB}MB（${new Date(s.afterAt).toLocaleTimeString()}），释放 ${s.freedMB}MB`
        : s.status === 'needsRestart'
          ? `记录值 ${s.beforeDgpuMB}MB，进程尚未在核显上重启，重启程序后生效`
          : s.status === 'cancelled'
            ? '偏好已改回，本次不计入释放'
            : `切换中：切换前 ${s.beforeDgpuMB}MB，等待进程重启`,
    };
  }

  /** test/diagnostics */
  getSessions() { return this._sessions.map((s) => this._publicSession(s)); }
  reset() { this._sessions = []; this._totalFreedMB = 0; this._persist(true); }
}

module.exports = { SavingsEngine, DEFAULT_DEADLINE_MS, RESTART_SETTLE_MS };