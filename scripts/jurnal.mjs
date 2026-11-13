// scripts/jurnal.mjs
import fs from 'node:fs';
import { bj, NOT, featScalp, scanInput, alertList } from '../core.mjs';
import { gradeTrade, mapK } from '../trade-sim.mjs';
import { engineHash, sealRow, lastSealed, ensureProtocol, RES } from '../forward-lib.mjs';
import { CFG, evaluate, selectDaily } from '../gate.mjs';

const DAY = 864e5, H = 36e5;
const F = 'data/journal.json';
const ENGINE = engineHash(fs.readFileSync(new URL('../core.mjs', import.meta.url), 'utf8'), fs.readFileSync(new URL('../trade-sim.mjs', import.meta.url), 'utf8'));
const AG = 'DeepScalp';
const q = v => +Number(v).toPrecision(5);

const rows = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : [];
const ids = new Set(rows.map(r => r.id));
const today = new Date().toISOString().slice(0, 10);
const PROTO = ensureProtocol(ENGINE);

async function grade(r) {
  const sym = r.aset + 'USDT';
  const t0 = Math.floor(r.t / 300000) * 300000;
  const g = await gradeTrade(r, {
    now: Date.now(),
    h5: async () => (await bj(`klines?symbol=${sym}&interval=5m&startTime=${t0}&limit=500`)).map(mapK),
    m1: async (a, b) => (await bj(`klines?symbol=${sym}&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).map(mapK),
  });
  if (g) { r.hasil = g.hasil; r.R = +g.R.toFixed(2); r.tx = g.t; }
}

// 1) nilai sinyal lama
for (const r of rows.filter(r => r.hasil === 'menunggu')) {
  try { await grade(r); } catch (e) { console.log('nilai gagal', r.id, e.message); }
}

// 2) scan sinyal baru
const t = await bj('ticker/24hr');
const top = t.filter(x => x.symbol.endsWith('USDT') && !NOT.test(x.symbol.slice(0, -4)))
  .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 20);

const F20 = [];
for (let i = 0; i < top.length; i += 5) {
  await Promise.all(top.slice(i, i + 5).map(async x => {
    try {
      const k15 = (await bj(`klines?symbol=${x.symbol}&interval=15m&limit=300`)).map(mapK);
      const k5 = (await bj(`klines?symbol=${x.symbol}&interval=5m&limit=200`)).map(mapK);
      const inp = scanInput(k15, k5);
      const f = featScalp(inp.bars15, inp.bars5);
      F20.push({ s: x.symbol.slice(0, -4), qv: +x.quoteVolume, ...f });
    } catch (e) { /* skip */ }
  }));
}

const sig = F20.filter(f => f.side && f.slp <= 1.5).sort((a, b) => b.why.length - a.why.length);
const al = alertList().map(a => a[1]).join('; ');
const cand = sig.slice(0, 8);

for (const f of sig) {
  const id = `${new Date().toISOString().slice(0, 16)}|${AG}|${f.s}`;
  if (ids.has(id)) continue;
  ids.add(id);
  const row = {
    id, waktu: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    t: Date.now(), due: Date.now() + 12 * H, agen: AG, aset: f.s, arah: f.side === 1 ? 'LONG' : 'SHORT',
    entry: q(f.entry), sl: q(f.sl), tp1: q(f.tp1), tp2: q(f.tp2), harga_awal: q(f.px),
    keyakinan: '', alasan: f.why.join('; '), alert: al, hasil: 'menunggu', R: '', engine: ENGINE,
  };
  const ev = evaluate(f, {});
  if (!ev.ok) continue;
  sealRow(row, lastSealed(rows));
  rows.push(row);
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(F, JSON.stringify(rows, null, 1));
console.log('baris:', rows.length);
