'use strict';
/**
 * charts.js — 无依赖 Canvas 图表。只用三种：双曲线面积图、迷你条形、圆环。
 * 所有绘制都按 devicePixelRatio 缩放，文字颜色跟随主题变量。
 */
(function () {
  const cssVar = (name, fb) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  };

  function fit(canvas) {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // 单调三次平滑，避免过冲
  function smoothPath(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) return;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const t = 0.18;
      const c1x = p1.x + (p2.x - p0.x) * t;
      const c1y = p1.y + (p2.y - p0.y) * t;
      const c2x = p2.x - (p3.x - p1.x) * t;
      const c2y = p2.y - (p3.y - p1.y) * t;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  }

  function fmtMB(v) {
    if (v == null) return '—';
    if (v >= 1024) return (v / 1024).toFixed(v >= 10240 ? 0 : 1) + ' GB';
    return Math.round(v) + ' MB';
  }

  /**
   * 双系列面积图。
   * @param {HTMLCanvasElement} canvas
   * @param {{points:Array<{t:number,d:number,i:number}>, hover:number, themes:string}} opts
   */
  function area(canvas, opts) {
    const o = opts || {};
    const points = Array.isArray(o.points) ? o.points : [];
    const f = fit(canvas);
    if (!f) return null;
    const { ctx, w, h } = f;
    const ink3 = cssVar('--ink-3', '#8A879F');
    const ink4 = cssVar('--ink-4', '#B4B1C4');
    const lineC = cssVar('--line', 'rgba(0,0,0,.07)');

    const padR = 46, padB = 20, padT = 10, padL = 2;
    const cw = w - padL - padR;
    const ch = h - padT - padB;

    if (points.length < 2) {
      ctx.fillStyle = ink4;
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('正在采集数据…', w / 2, h / 2);
      return null;
    }

    let max = 1;
    for (const p of points) max = Math.max(max, p.d || 0, p.i || 0);
    // 网格上限取整到 512MB 的倍数，视觉稳定
    const step = Math.max(256, Math.ceil(max / 4 / 256) * 256);
    const top = step * 4;
    const xAt = (idx) => padL + (cw * idx) / (points.length - 1);
    const yAt = (v) => padT + ch - (Math.min(v, top) / top) * ch;

    // 网格
    ctx.save();
    ctx.strokeStyle = lineC;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.font = '9.5px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.fillStyle = ink4;
    ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const v = step * i;
      const y = Math.round(yAt(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();
      ctx.fillText(v === 0 ? '0' : fmtMB(v), padL + cw + 8, y + 3);
    }
    ctx.restore();

    const build = (key) => points.map((p, idx) => ({ x: xAt(idx), y: yAt(p[key] || 0) }));

    // 独显：渐变面积
    const pD = build('d');
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
    grad.addColorStop(0, 'rgba(95, 77, 255, .26)');
    grad.addColorStop(0.55, 'rgba(95, 77, 255, .09)');
    grad.addColorStop(1, 'rgba(95, 77, 255, 0)');
    ctx.beginPath();
    smoothPath(ctx, pD);
    ctx.lineTo(pD[pD.length - 1].x, padT + ch);
    ctx.lineTo(pD[0].x, padT + ch);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 独显线
    ctx.beginPath();
    smoothPath(ctx, pD);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#5F4DFF';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(95, 77, 255, .45)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 核显：细虚线
    const pI = build('i');
    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, pI);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(14, 175, 126, .85)';
    ctx.stroke();
    ctx.restore();

    // hover
    if (o.hover != null && points[o.hover]) {
      const x = xAt(o.hover);
      const yD = yAt(points[o.hover].d || 0);
      const yI = yAt(points[o.hover].i || 0);
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 110, 180, .35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + ch);
      ctx.stroke();
      ctx.restore();

      for (const [y, c] of [[yD, '#5F4DFF'], [yI, '#0EAF7E']]) {
        ctx.beginPath();
        ctx.arc(x, y, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = c;
        ctx.stroke();
      }
    }

    // x 轴时间标签
    ctx.fillStyle = ink3;
    ctx.font = '9.5px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    const span = points[points.length - 1].t - points[0].t;
    const shortSpan = span < 120000;
    const ticks = 4;
    let lastLabel = '';
    for (let i = 0; i < ticks; i++) {
      const idx = Math.round((points.length - 1) * (i / (ticks - 1)));
      const t = points[idx].t;
      const d = new Date(t);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const label = shortSpan ? `${mm}:${ss}` : `${hh}:${mm}`;
      if (label === lastLabel) continue;
      lastLabel = label;
      const x = Math.min(Math.max(xAt(idx), 22), padL + cw - 18);
      ctx.fillText(label, x, h - 4);
    }

    return { xAt, indexAt: (x) => {
      const rel = (x - padL) / cw;
      return Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1))));
    } };
  }

  function ring(host, opts) {
    const o = opts || {};
    const size = o.size || 132;
    const stroke = o.stroke || 10;
    const pct = Math.max(0, Math.min(1, o.pct || 0));
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    host.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" />
        <circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
          stroke="${o.color || '#5F4DFF'}"
          stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" />
      </svg>
      <div class="ring-center">${o.center || ''}</div>`;
  }

  window.Charts = { area, ring, fmtMB };
})();
