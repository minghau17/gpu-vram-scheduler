'use strict';
/**
 * qa-run.js — 交互冒烟脚本（由主进程 --qa 触发，跑在真实 IPC 环境里）。
 * 逐页截图 + 切一次偏好 + 打开优化弹层 + 搜索 + 预算方案，输出 qa-report.json。
 */
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run(win, outDir) {
  const OUT = outDir;
  fs.mkdirSync(OUT, { recursive: true });
  const errors = [];
  const steps = [];

  win.webContents.on('console-message', (eventOrLevel, levelArg, messageArg) => {
    const level = typeof eventOrLevel === 'object' ? eventOrLevel.level : levelArg;
    const message = typeof eventOrLevel === 'object' ? eventOrLevel.message : messageArg;
    if (level === 'error' || level === 'warning' || level === 2 || level === 3) {
      errors.push(String(message).slice(0, 300));
    }
  });

  const js = async (label, code) => {
    try {
      const v = await win.webContents.executeJavaScript(code, true);
      steps.push({ label, ok: true });
      return v;
    } catch (e) {
      steps.push({ label, ok: false, error: String(e.message).slice(0, 200) });
      return null;
    }
  };
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  };

  await sleep(4500);
  const report = {};
  report.rows = await js('count rows', `document.querySelectorAll('[data-row]').length`);
  report.navItems = await js('count nav', `document.querySelectorAll('[data-nav]').length`);
  report.pageTitle = await js('title', `document.getElementById('pageTitle').textContent`);

  for (const pg of ['dashboard', 'apps', 'insights', 'settings']) {
    await js('nav ' + pg, `document.querySelector('[data-nav="${pg}"]').click()`);
    await sleep(800);
    await shot('page-' + pg);
  }

  await js('back to apps', `document.querySelector('[data-nav="apps"]').click()`);
  await sleep(600);
  await js('click igpu', `(document.querySelector('.app-row [data-pref="1"]')||{click(){}}).click()`);
  await sleep(1600);
  report.toastAfterPref = await js('toast', `(document.querySelector('.toast')||{}).innerText || ''`);
  await shot('qa-after-pref');

  await js('open optimize', `(document.querySelector('[data-act="optimize"]')||{click(){}}).click()`);
  await sleep(1800);
  report.sheetOpen = await js('sheet open', `!document.getElementById('sheetLayer').hidden`);
  report.sheetItems = await js('sheet items', `document.querySelectorAll('.sheet .sheet-item').length`);
  report.sheetTotal = await js('sheet total', `(document.querySelector('.sheet-total b')||{}).textContent || ''`);
  await shot('qa-sheet-optimize');
  await js('close sheet', `(document.querySelector('[data-sheet-close]')||{click(){}}).click()`);
  await sleep(300);

  await js('search', `(()=>{const i=document.getElementById('searchInput'); if(!i) return 'noinput'; i.value='steam'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()`);
  await sleep(800);
  report.searchRows = await js('search rows', `document.querySelectorAll('[data-row]').length`);
  await js('clear search', `(()=>{const i=document.getElementById('searchInput'); if(i){i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await sleep(500);

  await js('to insights', `document.querySelector('[data-nav="insights"]').click()`);
  await sleep(700);
  await js('open calc', `(document.querySelector('[data-act="calcPlan"]')||{click(){}}).click()`);
  await sleep(900);
  report.calcSheetOpen = await js('calc sheet', `!document.getElementById('sheetLayer').hidden`);
  await shot('qa-sheet-calc');

  report.steps = steps;
  report.errors = errors;
  fs.writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('[qa] ' + JSON.stringify(report, null, 1));
  return report;
};
