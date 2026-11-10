'use strict';
/**
 * measure.js — 显存释放 A/B 实测引擎。
 *
 * 为什么需要它：注册表切换只是「偏好」，真正释放多少只能量出来。
 * 流程（每个阶段都由 bridge 的 tick 驱动）：
 *   baseline  采样 N 秒，记录独显已用显存均值 + 目标应用自身占用
 *   applying  把目标应用写成「节能（核显）」
 *   waiting   等目标进程重启（DirectX 只在进程启动时读偏好）；超时则降级为估算
 *   measure   重启后再采样 N 秒，算净变化
 *   done      输出 beforeAvg / afterAvg / freedMB / 置信度 / 逐应用明细
 *
 * 只依赖传入的 snapshot 与回调，不碰 Electron API，便于用假数据单测。
 */
const PHASES = ['idle', 'baseline', 'applying', 'waiting', 'measure', 'done', 'cancelled'];

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(avg(arr.map((v) => (v - m) ** 2)));
}
function keyOf(p) { return String(p || '').toLowerCase(); }

class MeasureEngine {
  constructor(opts) {
    const o = opts || {};
    this.getSnapshot = o.getSnapshot;
    this.setPreference = o.setPreference;      // async (path, pref) => {ok}
    this.onUpdate = typeof o.onUpdate === 'function' ? o.onUpdate : () => {};
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();

    this.phase = 'idle';
    this.targets = [];          // [{exePath,name,beforeMB,afterMB,pids}]
    this.baselineSamples = [];
    this.afterSamples = [];
    this.baselineTarget = [];   // 目标应用占用采样
    this.afterTarget = [];
    this.startedAt = 0;
    this.phaseAt = 0;
    this.deadlineAt = 0;
    this.result = null;
    this.error = null;
    this._baselineMs = 15000;
    this._afterMs = 15000;
    this._settleUntil = 0;
    this._applied = false;
  }

  get state() {
    const s = this.getSnapshot ? this.getSnapshot() : null;
    const dgpu = s && Array.isArray(s.adapters) ? s.adapters.find((a) => a.kind === 'dgpu') : null;
    return {
      active: this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'cancelled',
      phase: this.phase,
      phases: PHASES,
      elapsedMs: this.phaseAt ? this.now() - this.phaseAt : 0,
      totalMs: this.phase === 'baseline' ? this._baselineMs : this.phase === 'measure' ? this._afterMs : 0,
      progress: this._progress(),
      targets: this.targets.map((t) => ({ exePath: t.exePath, name: t.name, beforeMB: t.beforeMB, afterMB: t.afterMB })),
      currentDgpuUsedMB: dgpu ? dgpu.usedMB : null,
      liveBaselineMB: this.baselineSamples.length ? Math.round(avg(this.baselineSamples.slice(-15))) : null,
      liveAfterMB: this.afterSamples.length ? Math.round(avg(this.afterSamples.slice(-15))) : null,
      result: this.result,
      error: this.error,
      hint: this._hint(),
    };
  }

  _progress() {
    if (this.phase === 'baseline') return Math.min(1, (this.now() - this.phaseAt) / this._baselineMs);
    if (this.phase === 'measure') return Math.min(1, Math.max(0, (this.now() - this.phaseAt) / this._afterMs));
    if (this.phase === 'waiting') return Math.min(0.98, (this.now() - this.phaseAt) / (this.deadlineAt - this.phaseAt || 1));
    if (this.phase === 'done') return 1;
    return 0;
  }

  _hint() {
    switch (this.phase) {
      case 'baseline': return '正在记录切换前的独显占用基线，请先别启动新程序';
      case 'applying': return '正在写入显卡偏好…';
      case 'waiting': return '已写入偏好。请重启被标记的程序（关闭后重新打开），DirectX 只在进程启动时读取偏好';
      case 'measure': return '检测到程序已重启，正在采样切换后的占用';
      case 'done': return '实测完成';
      default: return '';
    }
  }

  async start(opts) {
    const o = opts || {};
    const exePaths = Array.isArray(o.exePaths) ? o.exePaths.filter(Boolean) : [];
    if (!exePaths.length) throw new Error('实测至少需要一个目标程序');
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'cancelled') {
      throw new Error('已有实测在进行中');
    }
    const snap = this.getSnapshot();
    if (!snap) throw new Error('还没拿到显存数据，稍后再试');

    this._baselineMs = Math.max(6000, Number(o.baselineMs) || 15000);
    this._afterMs = Math.max(6000, Number(o.afterMs) || 15000);
    this.baselineSamples = [];
    this.afterSamples = [];
    this.baselineTarget = [];
    this.afterTarget = [];
    this.result = null;
    this.error = null;
    this._applied = false;
    this._settleUntil = 0;
    this.startedAt = this.now();
    this.phaseAt = this.now();
    this.phase = 'baseline';

    const apps = Array.isArray(snap.apps) ? snap.apps : [];
    this.targets = exePaths.map((p) => {
      const app = apps.find((a) => keyOf(a.exePath) === keyOf(p));
      return {
        exePath: p,
        name: app ? app.name : p.split(/[\\/]/).pop(),
        beforeMB: app ? Math.max(0, Math.round(app.dgpuMB || 0)) : 0,
        afterMB: null,
        pids: app && Array.isArray(app.pids) ? app.pids.slice().sort() : [],
        restarted: false,
      };
    });
    this.onUpdate(this.state);
    return this.state;
  }

  cancel(reason) {
    if (this.phase === 'idle') return this.state;
    this.phase = 'cancelled';
    this.phaseAt = this.now();
    this.error = reason || null;
    this.onUpdate(this.state);
    return this.state;
  }

  reset() {
    this.phase = 'idle';
    this.targets = [];
    this.baselineSamples = [];
    this.afterSamples = [];
    this.baselineTarget = [];
    this.afterTarget = [];
    this.result = null;
    this.error = null;
    this.phaseAt = 0;
    this.onUpdate(this.state);
    return this.state;
  }

  /** 每次 tick 由主进程调用。 */
  async onTick(snap) {
    if (!snap) return;
    const dgpu = (snap.adapters || []).find((a) => a.kind === 'dgpu');
    const usedMB = dgpu ? Number(dgpu.usedMB) || 0 : null;
    const apps = snap.apps || [];
    const sumTargets = (field) => this.targets.reduce((s, t) => {
      const app = apps.find((a) => keyOf(a.exePath) === keyOf(t.exePath));
      const v = app ? Math.max(0, Math.round(app.dgpuMB || 0)) : 0;
      if (field) t[field] = v;
      return s + v;
    }, 0);

    const now = this.now();

    if (this.phase === 'baseline') {
      if (usedMB != null) this.baselineSamples.push(usedMB);
      this.baselineTarget.push(sumTargets());
      if (now - this.phaseAt >= this._baselineMs) {
        this.phase = 'applying';
        this.phaseAt = now;
        this.onUpdate(this.state);
        await this._apply();
      } else {
        this.onUpdate(this.state);
      }
      return;
    }

    if (this.phase === 'waiting') {
      let allRestarted = true;
      for (const t of this.targets) {
        const app = apps.find((a) => keyOf(a.exePath) === keyOf(t.exePath));
        const pids = app && Array.isArray(app.pids) ? app.pids.slice().sort() : [];
        const changed = pids.length > 0 && JSON.stringify(pids) !== JSON.stringify(t.pids);
        if (changed) t.restarted = true;
        if (!t.restarted) allRestarted = false;
      }
      // 只在第一次检测到「全部重启」时设置一次静默窗，不能被每个 tick 推后
      if (allRestarted && this._settleUntil === 0) {
        this._settleUntil = now + 2500;
      }
      if (allRestarted && this._settleUntil > 0 && now >= this._settleUntil) {
        this.phase = 'measure';
        this.phaseAt = now;
        this.onUpdate(this.state);
        return;
      }
      if (!allRestarted && now > this.deadlineAt) {
        // 超时：降级为「按当前占用差估算」，并明确标注
        this._finish(true);
        return;
      }
      this.onUpdate(this.state);
      return;
    }

    if (this.phase === 'measure') {
      if (usedMB != null) this.afterSamples.push(usedMB);
      this.afterTarget.push(sumTargets('afterMB'));
      if (now - this.phaseAt >= this._afterMs) {
        this._finish(false);
      } else {
        this.onUpdate(this.state);
      }
    }
  }

  async _apply() {
    try {
      for (const t of this.targets) {
        const r = await this.setPreference(t.exePath, 1);
        if (!r || !r.ok) throw new Error((r && r.error) || ('写入失败：' + t.name));
      }
      this._applied = true;
      this.phase = 'waiting';
      this.phaseAt = this.now();
      this.deadlineAt = this.now() + 120000;   // 2 分钟内等重启
      this.onUpdate(this.state);
    } catch (e) {
      this.error = e.message;
      this.phase = 'done';
      this.phaseAt = this.now();
      this.onUpdate(this.state);
    }
  }

  _finish(estimated) {
    const baseAvg = avg(this.baselineSamples.slice(-Math.max(5, Math.floor((this._baselineMs / 2000)))) ) || avg(this.baselineSamples);
    const snapNow = this.getSnapshot();
    const dgpuNow = snapNow && Array.isArray(snapNow.adapters) ? snapNow.adapters.find((a) => a.kind === 'dgpu') : null;
    const afterAvg = estimated
      ? (dgpuNow ? Number(dgpuNow.usedMB) || 0 : 0)
      : (avg(this.afterSamples.slice(-Math.max(5, Math.floor(this._afterMs / 2000)))) || avg(this.afterSamples));

    const baseTarget = avg(this.baselineTarget.slice(-Math.max(5, Math.floor(this._baselineMs / 2000)))) || avg(this.baselineTarget);
    const afterTarget = estimated ? this.targets.reduce((s, t) => s + (t.afterMB || 0), 0) : (avg(this.afterTarget.slice(-5)) || avg(this.afterTarget));

    const freedMB = Math.round(baseAvg - afterAvg);
    const targetDrop = Math.round(baseTarget - afterTarget);
    const noise = Math.round(stdev(this.baselineSamples.concat(this.afterSamples)));
    const confidence = estimated ? 'estimated' : (noise <= 80 ? 'high' : noise <= 220 ? 'medium' : 'low');

    this.result = {
      finishedAt: Date.now(),
      estimated: !!estimated,
      baselineAvgMB: Math.round(baseAvg),
      afterAvgMB: Math.round(afterAvg),
      freedMB,
      targetBeforeMB: Math.round(baseTarget),
      targetAfterMB: Math.round(afterTarget),
      targetDropMB: targetDrop,
      noiseMB: noise,
      confidence,
      baselineSeconds: Math.round(this._baselineMs / 1000),
      afterSeconds: Math.round(this._afterMs / 1000),
      targets: this.targets.map((t) => ({
        exePath: t.exePath,
        name: t.name,
        beforeMB: t.beforeMB,
        afterMB: t.afterMB,
        restarted: t.restarted,
      })),
    };
    this.phase = 'done';
    this.phaseAt = this.now();
    this.onUpdate(this.state);
    return this.result;
  }
}

module.exports = { MeasureEngine };
