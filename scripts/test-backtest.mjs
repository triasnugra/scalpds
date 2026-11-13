// scripts/test-backtest.mjs
import { install } from './fake-binance.mjs';
import { runBacktest, buildReport, DEFAULTS } from './backtest.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => {
  if (c) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  GAGAL', name, extra); }
};

console.log('\n[Backtest scalping offline]');
const fk = install({ seed: 500 });
const o = { ...DEFAULTS, top: 8, days: 30, boot: 300 };
const { trades, meta } = await runBacktest(o);
fk.restore();

ok(meta.used >= 6, `pair terpakai ${meta.used} >= 6`, JSON.stringify(meta));
ok(trades.length > 20, `menghasilkan ${trades.length} sinyal (>20)`);
ok(trades.every(x => Number.isFinite(x.R)), 'semua R bernilai angka');
ok(trades.every(x => x.t + o.holdH * 3600000 <= Date.now()), 'tidak ada trade belum jatuh tempo');
ok(trades.every(x => x.hasil !== 'tidak terisi' || x.R === 0), 'tidak terisi = 0R');

const rep = buildReport(trades, o, meta);
ok(/Per trigger/.test(rep.md), 'laporan memuat tabel per trigger');
ok(/CI 95%/.test(rep.md), 'laporan memuat CI 95%');

console.log(`\n${fail ? 'GAGAL' : 'SEMUA LULUS'}: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
