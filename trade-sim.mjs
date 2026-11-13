// trade-sim.mjs — penilaian trade scalping (5m/15m)
export const MS5 = 300000;
export const MS15 = 900000;

export const mapK = a => ({ ot: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], ct: a[6] });

const rules = r => {
  const s = r.arah === 'LONG' ? 1 : -1;
  return {
    s,
    touch: k => (s === 1 ? k.l <= r.entry : k.h >= r.entry),
    open: k => (s === 1 ? k.o <= r.entry : k.o >= r.entry),
    sl: k => (s === 1 ? k.l <= r.sl : k.h >= r.sl),
    tp1: k => (s === 1 ? k.h >= r.tp1 : k.l <= r.tp1),
    tp2: k => (s === 1 ? k.h >= r.tp2 : k.l <= r.tp2),
  };
};

function walk(cs, P, st) {
  for (const k of cs) {
    if (!st.fill) {
      const ao = P.open(k);
      if (!ao && !P.touch(k)) continue;
      st.fill = true;
      if (P.sl(k)) return { res: 'SL', t: k.ot };
      if (ao && P.tp2(k)) return { res: 'TP2', t: k.ot };
      if (ao && P.tp1(k)) return { res: 'TP1', t: k.ot };
      continue;
    }
    if (P.sl(k)) return { res: 'SL', t: k.ot };
    if (P.tp2(k)) return { res: 'TP2', t: k.ot };
  }
  return null;
}

export async function gradeTrade(r, { h5, m1, now = Date.now() }) {
  const P = rules(r), risk = Math.abs(r.entry - r.sl), st = { fill: false };
  if (!(risk > 0)) return { hasil: 'tidak valid', R: 0, t: r.t };

  const done = w => ({
    hasil: w.res,
    R: w.res === 'SL' ? -1 : w.res === 'TP1' ? 1 : 2,
    t: w.t,
  });

  const cs = (await h5()).filter(k => k.ct < now);
  if (cs.length && cs[0].ot < r.t) {
    const k0 = cs.shift();
    if (m1) {
      const ms = (await m1(Math.max(k0.ot, r.t), k0.ct)).filter(m => m.ot >= r.t);
      const w = walk(ms, P, st);
      if (w) return done(w);
    }
  }

  let last = null;
  for (const k of cs) {
    if (k.ct > r.due) break;
    last = k;
    const w = walk([k], P, st);
    if (w) return done(w);
  }

  if (now < r.due) return null;
  if (!st.fill) return { hasil: 'tidak terisi', R: 0, t: r.due };
  return { hasil: 'kedaluwarsa', R: (P.s * ((last ? last.c : r.entry) - r.entry)) / risk, t: r.due };
}
