// scripts/fake-binance.mjs
const M5 = 300000, M15 = 900000;
const SYMS = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'LINK', 'AVAX'];
function mul(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function install({ days = 30, seed = 500 } = {}) {
  const NOW = Date.now(), start = Math.floor(NOW / 864e5) * 864e5 - days * 864e5, end5 = Math.floor(NOW / M5) * M5;
  const k5 = {}, k15 = {};
  SYMS.forEach((s, si) => {
    const r = mul(seed + si); let p = 100 + si * 10;
    const bars5 = [];
    for (let t = start; t <= end5; t += M5) {
      const o = p, c = p * (1 + (r() - 0.5) * 0.004); p = c;
      bars5.push([t, o, Math.max(o, c) * (1 + r() * 0.001), Math.min(o, c) * (1 - r() * 0.001), c, (50 + r() * 50) * 1000, t + M5 - 1]);
    }
    k5[s] = bars5;
    const m15 = new Map();
    for (const b of bars5) {
      const k = Math.floor(b[0] / M15) * M15, x = m15.get(k);
      if (!x) m15.set(k, [k, b[1], b[2], b[3], b[4], b[5], k + M15 - 1]);
      else { x[2] = Math.max(x[2], b[2]); x[3] = Math.min(x[3], b[3]); x[4] = b[4]; x[5] += b[5]; }
    }
    k15[s] = [...m15.values()];
  });
  const real = globalThis.fetch, calls = { n: 0 };
  globalThis.fetch = async url => {
    calls.n++;
    const u = new URL(url), j = v => ({ ok: true, status: 200, json: async () => v, text: async () => '' });
    if (u.pathname.endsWith('/ticker/24hr'))
      return j(SYMS.map((s, i) => ({ symbol: s + 'USDT', quoteVolume: String(1e9 - i * 1e7) })));
    if (u.pathname.endsWith('/klines')) {
      const sym = u.searchParams.get('symbol').replace('USDT', ''), iv = u.searchParams.get('interval');
      const src = iv === '5m' ? k5[sym] : iv === '15m' ? k15[sym] : null;
      if (!src) return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad interval' };
      const st = +(u.searchParams.get('startTime') || 0), en = +(u.searchParams.get('endTime') || 9e15), lim = +(u.searchParams.get('limit') || 500);
      return j(src.filter(r => r[0] >= st && r[0] <= en).slice(0, lim).map(r => [...r, 0, 0, 0, 0, 0]));
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'nf' };
  };
  return { restore: () => { globalThis.fetch = real; }, calls, k5, k15 };
}
