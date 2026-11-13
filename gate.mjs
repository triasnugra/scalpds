// gate.mjs — gerbang kualitas scalping
export const CFG = Object.freeze({
  maxSlPct: 1.5,
  minRR: 1.2,
  minQuoteVolUsd: 5e6,
  maxDistPct: 0.5,
  maxSignalsPerScan: 3,
  maxSameSidePerScan: 2,
  staleBars: 3,
  killzoneOnly: false,
});

export const SYMBOL_RE = /^[A-Z0-9]{2,15}$/;
const ok = x => Number.isFinite(+x) && x !== '' && x !== null;

export function validateSymbol(s) {
  if (s === undefined || s === null || String(s).trim() === '') return 'SYMBOL_KOSONG';
  if (!SYMBOL_RE.test(String(s))) return 'SYMBOL_ANEH';
  return null;
}

export function validateSetup(f, cfg = CFG) {
  const R = [];
  if (![f.px, f.entry, f.sl, f.tp1, f.tp2].every(ok)) R.push('DATA_TIDAK_VALID');
  if (R.length) return R;
  const s = f.side;
  if (s !== 1 && s !== -1) { R.push('ARAH_TIDAK_VALID'); return R; }
  if (!(s * (f.entry - f.sl) > 0 && s * (f.tp1 - f.entry) > 0 && s * (f.tp2 - f.entry) > 0)) R.push('URUTAN_HARGA_SALAH');
  if ((Math.abs(f.entry - f.sl) / f.entry) * 100 > cfg.maxSlPct) R.push('SL_TERLALU_LEBAR');
  if (Math.abs(f.tp2 - f.entry) / Math.abs(f.entry - f.sl) < cfg.minRR) R.push('RR_KURANG');
  if (ok(f.qv) && f.qv < cfg.minQuoteVolUsd) R.push('VOLUME_TIPIS');
  return R;
}

export function staleTp(f, cfg = CFG) {
  const c = (f.k || []).slice(-1 - cfg.staleBars, -1);
  if (!c.length) return false;
  return f.side === 1 ? c.some(q => q.h >= f.tp2) : c.some(q => q.l <= f.tp2);
}

export function evaluate(f, ctx = {}, cfg = CFG) {
  const reasons = validateSetup(f, cfg);
  if (reasons.length) return { ok: false, reasons, score: 0 };
  const dist = Math.abs(f.px - f.entry) / f.px * 100;
  if (dist > cfg.maxDistPct) reasons.push('ENTRY_TERLALU_JAUH');
  if (staleTp(f, cfg)) reasons.push('SETUP_BASI');
  if (cfg.killzoneOnly && !f.killzone) reasons.push('DI_LUAR_KILLZONE');
  return { ok: !reasons.length, reasons, score: (f.why || []).length };
}

export function selectDaily(items, already = {}, cfg = CFG) {
  const sorted = [...items].sort((a, b) => b.g.score - a.g.score || Math.abs(a.f.px - a.f.entry) - Math.abs(b.f.px - b.f.entry) || String(a.f.s).localeCompare(String(b.f.s)));
  let tot = already.total || 0, lg = already.long || 0, sh = already.short || 0;
  const keep = [], drop = [];
  for (const it of sorted) {
    const isL = it.f.side === 1;
    if (tot >= cfg.maxSignalsPerScan || (isL ? lg : sh) >= cfg.maxSameSidePerScan) { drop.push({ item: it, reason: 'DI_LUAR_BATAS' }); continue; }
    keep.push(it); tot++; if (isL) lg++; else sh++;
  }
  return { keep, drop };
}

export function riskPlan({ capital, riskPct, entry, sl, lulus = false }) {
  const cap = lulus ? 1 : 0.5, req = +riskPct || 0, eff = Math.min(req, cap), notes = [];
  if (!(capital > 0) || !(entry > 0) || !(sl > 0) || entry === sl) return { riskPctEff: 0, riskUsd: 0, qty: 0, notional: 0, leverage: 0, notes: ['data tidak lengkap'] };
  if (req > cap) notes.push(`risiko dibatasi ${cap}%`);
  const riskUsd = capital * eff / 100, qty = riskUsd / Math.abs(entry - sl), notional = qty * entry;
  return { riskPctEff: eff, riskUsd, qty, notional, leverage: notional / capital, notes };
}
