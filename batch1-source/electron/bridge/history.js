'use strict';
/**
 * history.js — 内存环形缓冲，供仪表盘实时曲线使用。
 * 每个 tick push 一条 { ts, dgpuUsedMB, igpuUsedMB }（外加 dgpuTotalMB 便于画百分比），
 * getHistory(minutes) 按时间窗过滤。不落盘（重启即清空，SPEC 要求内存内）。
 */
const DEFAULT_MAX_POINTS = 12000; // 2s × 12000 ≈ 6.7 小时

class History {
  constructor(opts) {
    const o = opts || {};
    this.maxPoints = Number(o.maxPoints) || DEFAULT_MAX_POINTS;
    this._points = [];
  }

  push(snapshot) {
    if (!snapshot) return;
    const point = {
      ts: Number(snapshot.ts) || Date.now(),
      dgpuUsedMB: Number(snapshot.totals && snapshot.totals.dgpuUsedMB) || 0,
      igpuUsedMB: Number(snapshot.totals && snapshot.totals.igpuUsedMB) || 0,
      dgpuTotalMB: Number(snapshot.totals && snapshot.totals.dgpuTotalMB) || 0,
    };
    this._points.push(point);
    if (this._points.length > this.maxPoints) {
      this._points.splice(0, this._points.length - this.maxPoints);
    }
  }

  /** @param {number} minutes 时间窗（分钟），默认 30 */
  getHistory(minutes) {
    const m = Number(minutes);
    const windowMs = (isFinite(m) && m > 0 ? m : 30) * 60 * 1000;
    if (this._points.length === 0) return [];
    const cutoff = this._points[this._points.length - 1].ts - windowMs;
    return this._points.filter((p) => p.ts >= cutoff);
  }

  /** 最近一个点（给 UI 快速读） */
  last() { return this._points.length ? this._points[this._points.length - 1] : null; }
  size() { return this._points.length; }
  clear() { this._points = []; }
}

module.exports = { History };