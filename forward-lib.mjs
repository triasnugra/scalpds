// forward-lib.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, bootCI, FILLED } from './scripts/backtest-lib.mjs';

export const PROTOCOL_FILE = 'data/forward-protocol.json';
export const MIN_TRADES = 200;
export const MIN_DAYS = 30;
export const RES = h => h === 'TP1' || h === 'TP2' || h === 'SL' || h === 'kedaluwarsa' || h === 'tidak terisi';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const engineHash = (...texts) => sha(texts.map(t => String(t).replace(/\r\n/g, '\n')).join('\u0000')).slice(0, 16);

const SEAL = ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp1', 'tp2', 'harga_awal', 'alasan', 'alert', 'engine'];
const canon = r => JSON.stringify(SEAL.map(k => (r[k] === undefined ? null : r[k])));
const link = (prev, seq, r) => sha(`${prev}|${seq}|${canon(r)}`).slice(0, 20);

export const lastSealed = rows => { let m = null; for (const r of rows) if (r.fwd && (!m || r.seq > m.seq)) m = r; return m; };

export function sealRow(row, prev) {
  row.fwd = 1; row.seq = (prev ? prev.seq : 0) + 1; row.prev = prev ? prev.h : 'GENESIS'; row.h = link(row.prev, row.seq, row);
  return row;
}

export function verifyChain(rows) {
  const f = rows.filter(r => r.fwd).sort((a, b) => a.seq - b.seq), errors = []; let prev = 'GENESIS';
  f.forEach((r, i) => {
    if (r.seq !== i + 1) errors.push(`seq ${r.seq} tidak berurutan`);
    if (r.prev !== prev) errors.push(`baris ${r.id}: tautan putus`);
    if (r.h !== link(r.prev, r.seq, r)) errors.push(`baris ${r.id}: isi diubah`);
    prev = r.h;
  });
  return { ok: !errors.length, n: f.length, head: f.length ? f.at(-1).h : null, errors };
}

export function makeProtocol(engine, now = Date.now(), o = {}) {
  return {
    versi: 1, mulai: new Date(now).toISOString(), mulai_ms: now, engine, agen: o.agen || 'DeepScalp',
    aturan: { hold_jam: 12, maks_sl_persen: 1.5, satu_order_aktif_per_koin: true, biaya: { fee_persen_per_sisi: 0.02, slip_persen: 0.02 }, baseline_tp_kelipatan_risiko: 2 },
    syarat_evaluasi: { min_trade_terisi: MIN_TRADES, min_hari_berbeda: MIN_DAYS },
    kriteria_lulus: 'Setelah KEDUA syarat terpenuhi: batas bawah CI 95% (bootstrap per hari) rata-rata R per trade terisi setelah biaya > 0.',
    larangan: [
      'Mengubah core.mjs atau trade-sim.mjs. Hash berubah dan baris baru tidak dihitung.',
      'Mengubah syarat evaluasi setelah protokol dimulai.',
      'Mengedit atau menghapus baris jurnal.',
      'Menilai hasil sebelum syarat terpenuhi.',
    ],
  };
}

export function ensureProtocol(engine, file = PROTOCOL_FILE, now = Date.now(), o = {}) {
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const p = makeProtocol(engine, now, o);
  fs.writeFileSync(file, JSON.stringify(p, null, 1));
  return { ...p, created: true };
}

const costPct = P => 2 * P.aturan.biaya.fee_persen_per_sisi + P.aturan.biaya.slip_persen;
const netRow = (r, P) => ({ hasil: r.hasil, R: FILLED(r.hasil) ? r.R - costPct(P) / ((Math.abs(r.entry - r.sl) / r.entry) * 100) : 0, exitT: r.tx ?? r.due, t: r.t });

export function pickSignals(rows, P) {
  const base = rows.filter(r => r.fwd && r.agen === P.agen && r.t >= P.mulai_ms && (r.arah === 'LONG' || r.arah === 'SHORT') && r.hasil !== 'tidak valid' && r.hasil !== 'NO_TRADE');
  const same = base.filter(r => r.engine === P.engine).sort((a, b) => a.t - b.t);
  const other = base.length - same.length;
  if (!P.aturan.satu_order_aktif_per_koin) return { kept: same, other, skipped: 0 };
  const busy = new Map(), kept = []; let skipped = 0;
  for (const r of same) {
    if (r.t < (busy.get(r.aset) ?? 0)) { skipped++; continue; }
    kept.push(r); busy.set(r.aset, RES(r.hasil) ? (r.tx ?? r.due) : Infinity);
  }
  return { kept, other, skipped };
}

export function analyze(rows, P, { peek = false, B = 5000, seed = 1 } = {}) {
  const chain = verifyChain(rows), { kept, other, skipped } = pickSignals(rows, P);
  const done = kept.filter(r => RES(r.hasil)), pending = kept.length - done.length;
  const net = done.map(r => netRow(r, P)), S = summarize(net), C = bootCI(net, { B, seed });
  const need = P.syarat_evaluasi, days = C ? C.clusters : 0;
  const ready = S.filled >= need.min_trade_terisi && days >= need.min_hari_berbeda;
  const out = {
    chain, protocol: { mulai: P.mulai, engine: P.engine, agen: P.agen }, ready, locked: !ready && !peek, peek: !ready && peek,
    counts: { tercatat: kept.length, selesai: done.length, menunggu: pending, terisi: S.filled, hari_berbeda: days, diabaikan_mesin_lain: other, dilewati_dedupe: skipped },
    progress: { trade_terisi: [S.filled, need.min_trade_terisi], hari: [days, need.min_hari_berbeda] },
  };
  if (!ready && !peek) return out;
  const Cs = bootCI(net, { B, seed, all: true });
  out.hasil = { strategi: { ...S, ci: C, ciPerSinyal: Cs } };
  out.verdict = ready ? { pass: !!(C && C.lo > 0), why: C && C.lo > 0 ? 'CI di atas 0' : 'CI tidak di atas 0' } : { pass: null, why: 'INTIP: syarat belum terpenuhi' };
  return out;
}

const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '-');
const rr = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const ci = c => (c ? `[${rr(c.lo)}, ${rr(c.hi)}]` : 'n/a');

export function renderForward(a) {
  const c = a.counts, p = a.progress;
  let md = `# Forward test ${a.protocol.agen}\n\n- Mulai: ${a.protocol.mulai} | mesin: ${a.protocol.engine}\n`;
  md += `- Integritas: ${a.chain.ok ? `OK (${a.chain.n} baris)` : 'BERMASALAH: ' + a.chain.errors.slice(0, 5).join('; ')}\n`;
  md += `- Tercatat: ${c.tercatat} (selesai ${c.selesai}, menunggu ${c.menunggu})\n\n`;
  md += `## Kemajuan\n- Trade terisi: ${p.trade_terisi[0]} / ${p.trade_terisi[1]}\n- Hari berbeda: ${p.hari[0]} / ${p.hari[1]}\n\n`;
  if (a.locked) return md + '**BELUM BOLEH DIEVALUASI.** Angka disembunyikan sampai syarat terpenuhi.\n';
  const s = a.hasil.strategi;
  md += `## Hasil\n\n| Metrik | Nilai |\n|---|---|\n| Trade terisi | ${s.filled} |\n| Win rate | ${pct(s.win)} |\n| R/trade | ${rr(s.mean)} |\n| CI 95% | ${ci(s.ci)} |\n| Total R | ${rr(s.total)} |\n\n`;
  md += `**Keputusan: ${a.verdict.pass === null ? 'TIDAK SAH' : a.verdict.pass ? 'LULUS' : 'TIDAK LULUS'}** (${a.verdict.why})\n`;
  return md;
}
