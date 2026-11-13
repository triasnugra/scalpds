// scripts/backtest-lib.mjs
export const FILLED = h => h === 'TP1' || h === 'TP2' || h === 'SL' || h === 'kedaluwarsa';

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const median = a => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(rows) {
  const f = rows.filter(r => FILLED(r.hasil)), R = f.map(r => r.R), n = f.length;
  const tp1 = f.filter(r => r.hasil === 'TP1').length, tp2 = f.filter(r => r.hasil === 'TP2').length;
  const sl = f.filter(r => r.hasil === 'SL').length, tp = tp1 + tp2;
  const sum = R.reduce((a, b) => a + b, 0);
  const gw = R.filter(x => x > 0).reduce((a, b) => a + b, 0), gl = -R.filter(x => x < 0).reduce((a, b) => a + b, 0);
  let c = 0, pk = 0, dd = 0;
  for (const r of [...f].sort((a, b) => a.exitT - b.exitT)) { c += r.R; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  return {
    signals: rows.length, filled: n, fillRate: rows.length ? n / rows.length : NaN,
    tp, tp1, tp2, sl, win: tp + sl ? tp / (tp + sl) : NaN,
    mean: n ? sum / n : NaN, perSignal: rows.length ? sum / rows.length : NaN, median: median(R), total: sum, pf: gl ? gw / gl : n ? Infinity : NaN, maxDD: dd,
  };
}

export const dayKey = t => Math.floor(t / 864e5);

export function bootCI(rows, { B = 5000, seed = 1, alpha = 0.05, all = false } = {}) {
  const m = new Map();
  for (const r of rows) {
    if (!all && !FILLED(r.hasil)) continue;
    const k = dayKey(r.t), o = m.get(k) || { s: 0, n: 0 };
    o.s += r.R; o.n++; m.set(k, o);
  }
  const cl = [...m.values()], C = cl.length;
  if (C < 2) return null;
  const rnd = mulberry32(seed), means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let S = 0, N = 0;
    for (let i = 0; i < C; i++) { const p = cl[(rnd() * C) | 0]; S += p.s; N += p.n; }
    means[b] = N ? S / N : 0;
  }
  means.sort();
  return {
    lo: means[Math.floor((alpha / 2) * B)],
    hi: means[Math.min(B - 1, Math.floor((1 - alpha / 2) * B))],
    pLE0: means.reduce((a, x) => a + (x <= 0 ? 1 : 0), 0) / B,
    clusters: C,
  };
}

// ==== TAMBAHAN: sebelumnya tidak ada, dipakai scripts/backtest.mjs ====
export function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
