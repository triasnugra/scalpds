// core.mjs
// DeepScalp Engine — sinyal scalping berbasis price action + trigger
// Timeframe: 15m (tren) + 5m (entry). Tidak menggunakan data masa depan.

const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];
let hi = 0;

export async function bj(path) {
  let err;
  for (let t = 0; t < HOSTS.length; t++) {
    const h = HOSTS[(hi + t) % HOSTS.length];
    try {
      const r = await fetch(h + '/api/v3/' + path, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(h + ' HTTP ' + r.status);
      hi = (hi + t) % HOSTS.length;
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

export const NOT = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|USD1|XUSD|PAXG|USDE|PYUSD|U|USDS|USDD|RLUSD|BFUSD|USDG)$/;

// ---------- indikator dasar ----------
const ema = (a, n) => {
  const k = 2 / (n + 1);
  let e = a[0];
  return a.map(v => e = v * k + e * (1 - k));
};
const rsi = (c, n = 14) => {
  let g = 0, l = 0;
  return c.map((v, i) => {
    if (!i) return null;
    const d = v - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= n) { g += u / n; l += w / n; }
    else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + w) / n; }
    return i < n ? null : 100 - 100 / (1 + g / (l || 1e-9));
  });
};
const atr = (k, n = 14) => {
  const tr = k.map((x, i) => Math.max(
    x.h - x.l,
    i ? Math.abs(x.h - k[i - 1].c) : 0,
    i ? Math.abs(x.l - k[i - 1].c) : 0
  ));
  return tr.slice(-n).reduce((a, b) => a + b, 0) / n;
};
const obv = k => {
  let o = 0;
  return k.map((x, i) => {
    if (i) o += x.c > k[i - 1].c ? x.v : x.c < k[i - 1].c ? -x.v : 0;
    return o;
  });
};

// ---------- deteksi pola scalping ----------
// Fair Value Gap: celah antara high candle i-2 dan low candle i (bullish FVG)
function detectFVG(k, lookback = 10) {
  const fvgs = [];
  for (let i = 2; i < Math.min(k.length, lookback); i++) {
    const a = k[k.length - 1 - i], b = k[k.length - 1 - i + 1], c = k[k.length - 1 - i + 2];
    if (c.l > a.h) fvgs.push({ type: 'bull', top: c.l, bottom: a.h, idx: i });
    if (c.h < a.l) fvgs.push({ type: 'bear', top: a.l, bottom: c.h, idx: i });
  }
  return fvgs;
}

// Order Block: candle berlawanan terakhir sebelum impuls kuat
function detectOB(k, lookback = 20) {
  for (let i = 2; i < Math.min(k.length, lookback); i++) {
    const prev = k[k.length - 1 - i];
    const next = k[k.length - 1 - i + 1];
    const body = Math.abs(next.c - next.o);
    const range = next.h - next.l;
    if (range > 0 && body / range > 0.6) {
      if (next.c > next.o && prev.c < prev.o) return { type: 'bull', top: prev.h, bottom: prev.l, idx: i };
      if (next.c < next.o && prev.c > prev.o) return { type: 'bear', top: prev.h, bottom: prev.l, idx: i };
    }
  }
  return null;
}

// Volume imbalance: rasio volume beli vs jual dari candle 5m
function volumeDelta(k) {
  let buy = 0, sell = 0;
  for (const x of k.slice(-10)) {
    const body = Math.abs(x.c - x.o);
    const range = x.h - x.l || 1;
    const buyVol = x.v * (body / range) * (x.c > x.o ? 1 : 0.3);
    buy += buyVol;
    sell += x.v - buyVol;
  }
  return { buy, sell, ratio: sell > 0 ? buy / sell : 99 };
}

// Sweep likuiditas: harga menembus low/high lalu close kembali di dalam
function detectSweep(k, lookback = 20) {
  const recent = k.slice(-lookback);
  const lows = recent.map(x => x.l);
  const highs = recent.map(x => x.h);
  const minL = Math.min(...lows), maxH = Math.max(...highs);
  const last = k[k.length - 1];
  const sweepLow = last.l <= minL * 1.001 && last.c > minL;
  const sweepHigh = last.h >= maxH * 0.999 && last.c < maxH;
  return { sweepLow, sweepHigh, minL, maxH };
}

// Killzone: jam sesi dengan likuiditas tinggi (UTC)
function killzone(now = new Date()) {
  const h = now.getUTCHours();
  if (h >= 7 && h < 10) return 'London Open';
  if (h >= 12 && h < 15) return 'NY Open';
  if (h >= 20 && h < 23) return 'Asia Open';
  return null;
}

// ---------- fungsi utama ----------
// k15: candle 15m (minimal 200), k5: candle 5m (minimal 100), now: Date
// Mengembalikan objek sinyal atau side=0
export function featScalp(k15, k5, now = new Date()) {
  const c15 = k15.slice(0, -1), c5 = k5.slice(0, -1);
  if (c15.length < 120 || c5.length < 60) throw new Error('data 15m/5m kurang');

  const px = k5.at(-1).o; // harga open candle 5m berjalan
  const E20 = ema(c15.map(x => x.c), 20).at(-1);
  const E50 = ema(c15.map(x => x.c), 50).at(-1);
  const R = rsi(c15.map(x => x.c));
  const A = atr(c5);

  // tren 15m
  const tr = px > E20 && E20 > E50 ? 1 : px < E20 && E20 < E50 ? -1 : 0;

  // VWAP sesi (rolling 4 jam dari 5m)
  const vwap = (() => {
    const pv = c5.slice(-48).reduce((s, x) => s + ((x.h + x.l + x.c) / 3) * x.v, 0);
    const v = c5.slice(-48).reduce((s, x) => s + x.v, 0);
    return v ? pv / v : px;
  })();

  // range 60 candle 15m
  const H = Math.max(...c15.slice(-64, -4).map(x => x.h));
  const L = Math.min(...c15.slice(-64, -4).map(x => x.l));
  const pos = (px - L) / (H - L || 1);

  // pola
  const fvgs = detectFVG(c5);
  const ob = detectOB(c5);
  const sweep = detectSweep(c5);
  const vol = volumeDelta(c5);
  const vwapReclaim = (px > vwap && c5.at(-2).c < vwap) || (px < vwap && c5.at(-2).c > vwap);

  // skor kandidat
  let side = 0, why = [], trig = '';
  const reasons = [];

  if (tr === 1) {
    if (sweep.sweepLow) reasons.push('sweep low 5m + reclaim');
    if (fvgs.some(f => f.type === 'bull' && f.bottom < px && f.top > px * 0.999)) reasons.push('FVG bullish terisi');
    if (ob && ob.type === 'bull' && px >= ob.bottom && px <= ob.top * 1.002) reasons.push('retest OB bullish');
    if (vwapReclaim && px > vwap) reasons.push('reclaim VWAP');
    if (vol.ratio > 1.6) reasons.push('volume imbalance beli');
    if (reasons.length >= 2 && pos < 0.6) { side = 1; why = reasons; trig = 'scalp_long'; }
  } else if (tr === -1) {
    if (sweep.sweepHigh) reasons.push('sweep high 5m + reclaim');
    if (fvgs.some(f => f.type === 'bear' && f.top > px && f.bottom < px * 1.001)) reasons.push('FVG bearish terisi');
    if (ob && ob.type === 'bear' && px <= ob.top && px >= ob.bottom * 0.998) reasons.push('retest OB bearish');
    if (vwapReclaim && px < vwap) reasons.push('reject VWAP');
    if (vol.ratio < 0.6) reasons.push('volume imbalance jual');
    if (reasons.length >= 2 && pos > 0.4) { side = -1; why = reasons; trig = 'scalp_short'; }
  }

  if (!side) return { side: 0, px, tr, E20, E50, vwap, H, L, pos, A, fvgs, ob, sweep, vol, killzone: killzone(now) };

  // level entry: limit di retest level terdekat
  const s = side;
  let entry;
  if (s === 1) entry = Math.max(L + A * 0.2, Math.min(px, ob ? ob.bottom : vwap));
  else entry = Math.min(H - A * 0.2, Math.max(px, ob ? ob.top : vwap));

  // SL: di luar wick sweep / OB
  let sl;
  if (s === 1) sl = Math.min(ob ? ob.bottom : L, sweep.minL) - A * 0.3;
  else sl = Math.max(ob ? ob.top : H, sweep.maxH) + A * 0.3;

  // batasi SL maks 1.5%
  const risk = Math.abs(entry - sl);
  const slp = (risk / entry) * 100;
  if (slp > 1.5) return { side: 0, px, tr, E20, E50, vwap, H, L, pos, A, fvgs, ob, sweep, vol, killzone: killzone(now), rejected: 'SL > 1.5%' };

  const tp1 = entry + s * risk * 1.0; // partial TP 1R
  const tp2 = entry + s * risk * 2.0; // final TP 2R

  return {
    side, px, tr, E20, E50, vwap, H, L, pos, A,
    fvgs, ob, sweep, vol, killzone: killzone(now),
    why, trig, entry, sl, slp, risk, tp1, tp2,
    type: 'scalping',
  };
}

// Satu jalur masukan untuk live & backtest
export function scanInput(k15, k5, now = Date.now()) {
  const d15 = k15.filter(q => q.t + 900000 <= now);
  const d5 = k5.filter(q => q.t + 300000 <= now);
  const f15 = k15.find(q => q.t + 900000 > now);
  const f5 = k5.find(q => q.t + 300000 > now);
  if (!d15.length || !d5.length || !f15 || !f5) throw new Error('kline tidak lengkap');
  return {
    bars15: [...d15.slice(-199), { t: f15.t, o: f15.o, h: f15.o, l: f15.o, c: f15.o, v: 0 }],
    bars5: [...d5.slice(-99), { t: f5.t, o: f5.o, h: f5.o, l: f5.o, c: f5.o, v: 0 }],
  };
}

export function alertList(now = new Date()) {
  const h = now.getUTCHours();
  const A = [];
  if (h >= 1 && h < 4) A.push(['y', 'Jam sepi (01–04 UTC): spread melebar, hindari scalp.']);
  if (h >= 7 && h < 10) A.push(['g', 'London Open: likuiditas tinggi, killzone aktif.']);
  if (h >= 12 && h < 15) A.push(['g', 'NY Open: killzone aktif.']);
  return A;
}
