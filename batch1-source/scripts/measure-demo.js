'use strict';
/** 一次性演示实测：挑一个后台程序，跑完 baseline → 切换 → 重启 → 采样，输出真实数字。 */
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function (win, { measure, getSnapshot }) {
  await sleep(5000);
  const snap = getSnapshot();
  const apps = (snap && snap.apps) || [];
  const target = apps.filter((a) => a.exePath && a.category !== '系统' && a.dgpuMB >= 40 && a.dgpuMB <= 400 && a.pids && a.pids.length)
    .sort((a, b) => b.dgpuMB - a.dgpuMB)[0];
  if (!target) { console.log('[demo] no target'); return; }
  console.log('[demo] target', target.name, target.dgpuMB, target.exePath);

  await measure.start({ exePaths: [target.exePath], baselineMs: 15000, afterMs: 15000 });
  let restarted = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = measure.state;
    if (st.phase === 'waiting' && !restarted) {
      restarted = true;
      const pids = (target.pids || []).slice();
      console.log('[demo] restarting', pids);
      for (const pid of pids) { try { process.kill(pid); } catch (_) {} }
      await sleep(1500);
      await shell.openPath(target.exePath);
    }
    if (st.phase === 'done' || st.phase === 'cancelled') break;
  }
  await sleep(1200);
  const out = { target: target.name, result: measure.state.result };
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'demo-measure.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('[demo] result ' + JSON.stringify(out));
};
