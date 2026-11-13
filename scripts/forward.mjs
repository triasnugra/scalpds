#!/usr/bin/env node
// Forward test DeepScalp: report | verify [--regrade]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bj } from '../core.mjs';
import { gradeTrade, mapK } from '../trade-sim.mjs';
import { PROTOCOL_FILE, RES, analyze, verifyChain, renderForward } from '../forward-lib.mjs';

const F = 'data/journal.json';

export async function regrade(rows, P, log = () => {}) {
  const bad = []; let n = 0;
  for (const r of rows.filter(r => r.fwd && r.agen === P.agen && (r.arah === 'LONG' || r.arah === 'SHORT') && RES(r.hasil))) {
    const sym = r.aset + 'USDT', t0 = Math.floor(r.t / 300000) * 300000;
    try {
      const g = await gradeTrade(r, {
        now: Date.now(),
        h5: async () => (await bj(`klines?symbol=${sym}&interval=5m&startTime=${t0}&limit=1000`)).map(mapK),
        m1: async (a, b) => (await bj(`klines?symbol=${sym}&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).map(mapK),
      });
      n++;
      if (!g || g.hasil !== r.hasil || Math.abs(+g.R.toFixed(2) - +r.R) > 0.011 || (r.tx != null && g.t !== r.tx))
        bad.push({ id: r.id, tersimpan: `${r.hasil} ${r.R}`, penilaian_ulang: g ? `${g.hasil} ${g.R.toFixed(2)}` : 'belum selesai' });
    } catch (e) { log(`regrade gagal ${r.id}: ${e.message}`); }
  }
  return { checked: n, mismatches: bad };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd = 'report', ...flags] = process.argv.slice(2);
  if (!fs.existsSync(F) || !fs.existsSync(PROTOCOL_FILE)) {
    console.log('Forward test belum dimulai: jalankan scripts/jurnal.mjs sekali.');
    process.exit(0);
  }
  const rows = JSON.parse(fs.readFileSync(F, 'utf8'));

  if (cmd === 'report') {
    const P = JSON.parse(fs.readFileSync(PROTOCOL_FILE, 'utf8'));
    const a = analyze(rows, P, { peek: flags.includes('--peek') });
    const md = renderForward(a);
    fs.writeFileSync('data/forward-report.md', md);
    fs.writeFileSync('data/forward-report.json', JSON.stringify({ dibuat: new Date().toISOString(), ...a }, null, 1));
    console.log(md);
    if (!a.chain.ok) process.exitCode = 1;
  } else if (cmd === 'verify') {
    const c = verifyChain(rows);
    console.log(c.ok ? `Rantai OK: ${c.n} baris. Ujung: ${c.head}` : 'RANTAI BERMASALAH:\n- ' + c.errors.join('\n- '));
    if (process.env.GITHUB_STEP_SUMMARY && c.head)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Forward test\nUjung rantai: \`${c.head}\` (${c.n} baris) @ ${new Date().toISOString()}\n`);
    let bad = !c.ok;
    if (flags.includes('--regrade')) {
      const P = JSON.parse(fs.readFileSync(PROTOCOL_FILE, 'utf8'));
      const g = await regrade(rows, P, m => console.error(' ', m));
      console.log(`\nPenilaian ulang: ${g.checked} dicek, ${g.mismatches.length} berbeda.`);
      for (const m of g.mismatches) console.log(`- ${m.id}: ${m.tersimpan} → ${m.penilaian_ulang}`);
      bad = bad || g.mismatches.length > 0;
    }
    process.exit(bad ? 1 : 0);
  } else { console.log('perintah: report | verify [--regrade]'); process.exit(2); }
}
