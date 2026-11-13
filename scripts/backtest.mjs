#!/usr/bin/env node
// Backtest DeepScalp — sinyal dari 15m, fill/exit dari 5m (sama dengan live).
// Pakai: node scripts/backtest.mjs [opsi]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bj, NOT, featScalp } from '../core.mjs';
import { gradeTrade, mapK } from '../trade-sim.mjs';
import { summarize, bootCI, groupBy, FILLED } from './backtest-lib.mjs';

const DAY = 864e5;
const MIN5 = 300000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, n = 3) {
  let e;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (x) { e = x; await sleep(1000 * (i + 1)); }
  }
  throw e;
}
const iso = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

export const DEFAULTS = {
  top: 8, days: 30, fee: 0.02, slip: 0.02, holdH: 12,
  dedupe: true, boot: 2000, seed: 1, symbols: null,
  out: 'backtest/out', cache: 'backtest/cache',
};

const HELP = `node scripts/backtest.mjs [opsi]
  --top N        universe: N pair volume terbesar HARI INI (default 8)
  --days N       panjang riwayat dalam hari (default 30)
  --symbols A,B  daftar pair manual (mengabaikan --top)
  --hold N       durasi trade dalam jam (default 12)
  --fee P        biaya per sisi % (default 0.02)   --slip P  slippage % (default 0.02)
  --no-dedupe    catat semua sinyal (default: satu order aktif per koin)
  --boot N       jumlah resample bootstrap (default 2000)
  --out DIR      folder keluaran (default backtest/out)   --cache DIR  folder cache (default backtest/cache)
  --help`;

export function parseArgs(a) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < a.length; i++) {
    const x = a[i], nx = () => a[++i];
    if (x === '--top') o.top = +nx();
    else if (x === '--days') o.days = +nx();
    else if (x === '--hold') o.holdH = +nx();
    else if (x === '--fee') o.fee = +nx();
    else if (x === '--slip') o.slip = +nx();
    else if (x === '--boot') o.boot = +nx();
    else if (x === '--out') o.out = nx();
    else if (x === '--cache') o.cache = nx();
    else if (x === '--symbols') o.symbols = nx().split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (x === '--no-dedupe') o.dedupe = false;
    else if (x === '--help' || x === '-h') { console.log(HELP); process.exit(0); }
    else throw new Error('opsi tidak dikenal: ' + x + '\n' + HELP);
  }
  return o;
}

async function fetchKlines(sym, interval, fromMs, toMs) {
  const step = interval === '5m' ? 5 * MIN5 : 15 * MIN5;
  const out = [];
  let s = fromMs;
  for (let guard = 0; guard < 300; guard++) {
    const a = await retry(() => bj(`klines?symbol=${sym}USDT&interval=${interval}&startTime=${s}&limit=1000`));
    if (!a.length) break;
    for (const x of a) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] });
    const last = a.at(-1)[0];
    if (last >= toMs || a.length < 1000) break;
    s = last + step;
  }
  return out.filter(x => x.t >= fromMs && x.t <= toMs);
}

async function loadKlines(sym, interval, fromMs, toMs, o) {
  const f = path.join(o.cache, `${interval}-${sym}-${fromMs}-${toMs}.json`);
  if (fs.existsSync(f)) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c.length && c.at(-1).t >= toMs - 2 * (interval === '5m' ? MIN5 : 15 * MIN5)) return c;
    } catch {}
  }
  const data = await fetchKlines(sym, interval, fromMs, toMs);
  fs.mkdirSync(o.cache, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}

export async function runBacktest(o, log = () => {}) {
  fs.mkdirSync(o.cache, { recursive: true });
  const now = Date.now(), cost = 2 * o.fee + o.slip;
  const fromMs = now - o.days * DAY;
  const toMs = now - o.holdH * 3600000;

  let syms = o.symbols;
  if (!syms || !syms.length) {
    const t = await retry(() => bj('ticker/24hr'));
    syms = t.filter(x => x.symbol.endsWith('USDT') && !NOT.test(x.symbol.slice(0, -4)))
      .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, o.top).map(x => x.symbol.slice(0, -4));
  }
  log(`Backtest ${syms.length} pair × ${o.days} hari`);

  const trades = [];
  const meta = { symbols: syms, used: 0, skipped: [] };

  for (const sym of syms) {
    try {
      const k15 = await loadKlines(sym, '15m', fromMs, now, o);
      const k5 = await loadKlines(sym, '5m', fromMs, now, o);
      if (k15.length < 500 || k5.length < 1000) { meta.skipped.push(`${sym} (data kurang)`); continue; }
      meta.used++;

      let busy = 0, nSig = 0;
      for (let i = 200; i < k15.length; i++) {
        const t = k15[i].t;
        if (t < busy) continue;
        if (t + o.holdH * 3600000 > now) break;

        const h15 = k15.slice(0, i + 1);
        const h5 = k5.filter(b => b.t + MIN5 <= t + 15 * MIN5);
        if (h5.length < 100) continue;

        let f;
        try { f = featScalp(h15, h5); } catch { continue; }
        if (!f.side || f.slp > 1.5) continue;

        const due = t + o.holdH * 3600000;
        const sim5 = k5.filter(b => b.t >= t && b.t <= due);
        if (!sim5.length) continue;

        const g = await gradeTrade({
          arah: f.side === 1 ? 'LONG' : 'SHORT',
          entry: f.entry, sl: f.sl, tp1: f.tp1, tp2: f.tp2,
          t, due,
        }, { now, h5: async () => sim5.map(mapK) });
        if (!g) continue;

        const slp = (Math.abs(f.entry - f.sl) / f.entry) * 100;
        const netR = FILLED(g.hasil) ? g.R - cost / slp : 0;
        trades.push({
          sym, t, date: iso(t), side: f.side === 1 ? 'LONG' : 'SHORT',
          trig: f.trig, why: f.why.join('|'), entry: f.entry, sl: f.sl, tp1: f.tp1, tp2: f.tp2,
          slp, hasil: g.hasil, Rg: g.R, R: netR, exitT: g.t, killzone: f.killzone,
        });
        if (o.dedupe) busy = g.t;
        nSig++;
      }
      log(`${sym}: ${nSig} trade`);
    } catch (e) {
      log(`${sym} gagal: ${e.message}`);
      meta.skipped.push(`${sym} (${e.message})`);
    }
  }
  return { trades, meta };
}

const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '-');
const rr = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const ci = c => (c ? `[${rr(c.lo)}, ${rr(c.hi)}]` : 'n/a');

function groupTable(title, rows, keyFn, o) {
  const g = [...groupBy(rows, keyFn)].map(([k, v]) => [k, v, summarize(v)]).sort((a, b) => b[2].filled - a[2].filled);
  let md = `\n### ${title}\n\n| Grup | Terisi | Win% | R/trade | CI 95% |\n|---|---|---|---|---|\n`;
  for (const [k, v, s] of g) {
    const c = s.filled >= 20 ? bootCI(v, { B: o.boot, seed: o.seed }) : null;
    md += `| ${k} | ${s.filled} | ${pct(s.win)} | ${rr(s.mean)} | ${ci(c)} |\n`;
  }
  return md;
}

export function buildReport(trades, o, meta) {
  if (!trades.length) return { md: '# Backtest DeepScalp\n\nTidak ada sinyal pada periode ini. Coba --days lebih besar atau --top lebih banyak.\n', summary: { n: 0 } };
  const S = summarize(trades), C = bootCI(trades, { B: o.boot, seed: o.seed });
  let md = `# Backtest DeepScalp\n\n`;
  md += `- Pair dipakai: ${meta.used}/${meta.symbols.length}${meta.skipped.length ? ` (dilewati: ${meta.skipped.join(', ')})` : ''}\n`;
  md += `- Periode sinyal: ${trades[0].date} → ${trades.at(-1).date}\n`;
  md += `- Parameter: hold ${o.holdH} jam, SL maks 1.5%, biaya ${o.fee}%/sisi + slip ${o.slip}% (total ${(2 * o.fee + o.slip).toFixed(2)}%/trade), ${o.dedupe ? 'satu order aktif per koin' : 'semua sinyal dicatat'}\n`;
  md += `- Blok bootstrap: ${C ? C.clusters : 0} hari berbeda (ukuran sampel independen sebenarnya)\n\n`;
  md += `## Ringkasan\n\n| Metrik | Nilai |\n|---|---|\n| Sinyal | ${S.signals} |\n| Terisi | ${S.filled} (${pct(S.fillRate)}) |\n| TP1 / TP2 / SL / Exp | ${S.tp1} / ${S.tp2} / ${S.sl} / ${S.filled - S.tp1 - S.tp2 - S.sl} |\n| Win rate | ${pct(S.win)} |\n| R/trade | ${rr(S.mean)} |\n| CI 95% R/trade | ${ci(C)} |\n| R/sinyal | ${rr(S.perSignal)} |\n| Total R | ${rr(S.total)} |\n| Profit factor | ${Number.isFinite(S.pf) ? S.pf.toFixed(2) : '-'} |\n| Max DD (R) | ${S.maxDD.toFixed(1)} |\n\n`;
  md += `**Kesimpulan:** ${C && C.lo > 0 ? 'CI R/trade di atas 0 — edge positif terbukti secara statistik.' : 'CI R/trade mencakup atau di bawah 0 — edge belum terbukti.'}\n`;
  md += groupTable('Per trigger', trades, x => x.trig, o);
  md += groupTable('Per arah', trades, x => x.side, o);
  md += groupTable('Per killzone', trades, x => x.killzone || 'di luar killzone', o);
  md += groupTable('Per pair', trades, x => x.sym, o);
  md += `\n## Batasan\n- Backtest memakai 5m untuk fill/exit dan 15m untuk sinyal — sama dengan live.\n- Universe = top ${o.top} pair HARI INI (survivorship bias).\n- Funding futures dan slippage volatil tidak dimodelkan.\n- Hasil backtest bukan jaminan hasil live. Jalankan forward test dulu.\n`;
  return { md, summary: { params: o, meta, overall: { ...S, ci: C } } };
}

export function writeOutputs(trades, rep, o) {
  fs.mkdirSync(o.out, { recursive: true });
  const cols = ['sym', 'date', 'side', 'trig', 'slp', 'entry', 'sl', 'tp1', 'tp2', 'hasil', 'Rg', 'R', 'why', 'killzone'];
  const csv = [cols.join(','), ...trades.map(x => cols.map(c => (typeof x[c] === 'number' ? +x[c].toPrecision(6) : (x[c] ?? '').toString().replace(/,/g, ';'))).join(','))].join('\n');
  fs.writeFileSync(path.join(o.out, 'trades.csv'), csv);
  fs.writeFileSync(path.join(o.out, 'report.md'), rep.md);
  fs.writeFileSync(path.join(o.out, 'summary.json'), JSON.stringify(rep.summary, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const o = parseArgs(process.argv.slice(2));
  console.error(`Backtest ${o.symbols ? o.symbols.length + ' pair' : 'top ' + o.top} × ${o.days} hari...`);
  const { trades, meta } = await runBacktest(o, m => console.error(' ', m));
  const rep = buildReport(trades, o, meta);
  writeOutputs(trades, rep, o);
  console.log(rep.md);
  console.error(`\nTersimpan di ${o.out}/`);
}
