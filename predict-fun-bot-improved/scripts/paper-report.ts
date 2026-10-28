/** Offline ledger diagnostics. Never imports/starts the trading engine or calls an API. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Mode = 'paper' | 'live' | 'unknown';
type LedgerTrade = Record<string, unknown>;

export interface PerformanceSummary {
  count: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
}

export interface ModeSummary {
  records: number;
  completed: number;
  pending: number;
  filled: number;
  cancelled: number;
  uncertain: number;
  incompleteResolved: number;
  missingResolutionTime: number;
  pnl: {
    estimated: PerformanceSummary;
    actual: PerformanceSummary;
    unclassifiedCount: number;
    missingCount: number;
    allClassified: PerformanceSummary;
  };
}

interface ScoredTrade { pnl: number; timestamp: number; }

export function performance(trades: readonly ScoredTrade[]): PerformanceSummary {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  for (const trade of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.pnl > 0) { grossProfit += trade.pnl; wins++; }
    else if (trade.pnl < 0) { grossLoss -= trade.pnl; losses++; }
    else breakeven++;
  }
  return {
    count: trades.length, netPnl: equity, grossProfit, grossLoss, wins, losses, breakeven,
    winRatePct: trades.length ? wins / trades.length * 100 : null,
    // null means undefined; the renderer distinguishes no sample from no losses.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdown,
  };
}

function emptySummary(): ModeSummary {
  return {
    records: 0, completed: 0, pending: 0, filled: 0, cancelled: 0, uncertain: 0,
    incompleteResolved: 0, missingResolutionTime: 0,
    pnl: { estimated: performance([]), actual: performance([]), unclassifiedCount: 0,
      missingCount: 0, allClassified: performance([]) },
  };
}

export function summarizeLedger(input: unknown): {
  modes: Record<Mode, ModeSummary>;
  duplicateRecords: number;
  invalidRecords: number;
  excludedLegacyRecords: number;
} {
  if (!Array.isArray(input)) throw new Error('Ledger harus berupa array JSON.');
  const modes = { paper: emptySummary(), live: emptySummary(), unknown: emptySummary() };
  const buckets = {
    paper: { estimated: [] as ScoredTrade[], actual: [] as ScoredTrade[] },
    live: { estimated: [] as ScoredTrade[], actual: [] as ScoredTrade[] },
  };
  const seen = new Set<string>();
  let duplicateRecords = 0;
  let invalidRecords = 0;
  let excludedLegacyRecords = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { invalidRecords++; continue; }
    const trade = item as LedgerTrade;
    if (typeof trade.id !== 'string' || !trade.id) { invalidRecords++; continue; }
    if (seen.has(trade.id)) { duplicateRecords++; continue; }
    seen.add(trade.id);
    // IDs and file names cannot prove mode: require the explicit persisted field.
    const mode: Mode = trade.mode === 'paper' || trade.mode === 'live' ? trade.mode : 'unknown';
    const summary = modes[mode];
    summary.records++;
    if (mode === 'unknown') excludedLegacyRecords++;
    if (trade.isFilled === true) summary.filled++;
    if (trade.isCancelled === true) summary.cancelled++;
    const uncertain = trade.submissionUncertain === true || trade.reconciliationRequired === true;
    if (uncertain) summary.uncertain++;
    if (trade.resolved !== true) summary.pending++;
    if (trade.resolved !== true || trade.isCancelled === true) continue;
    if (trade.isFilled !== true || uncertain) { summary.incompleteResolved++; continue; }
    summary.completed++;
    // No financial metric from a record with an unknown/legacy mode.
    if (mode === 'unknown') continue;
    if (typeof trade.pnl !== 'number' || !Number.isFinite(trade.pnl)) { summary.pnl.missingCount++; continue; }
    if (typeof trade.pnlIsEstimate !== 'boolean') { summary.pnl.unclassifiedCount++; continue; }
    if (typeof trade.resolvedAt !== 'number' || !Number.isFinite(trade.resolvedAt) || trade.resolvedAt <= 0) {
      summary.missingResolutionTime++;
      // Omitting an unknown ordering avoids a misleading drawdown calculation.
      continue;
    }
    buckets[mode][trade.pnlIsEstimate ? 'estimated' : 'actual'].push({ pnl: trade.pnl, timestamp: trade.resolvedAt });
  }
  for (const mode of ['paper', 'live'] as const) {
    modes[mode].pnl.estimated = performance(buckets[mode].estimated);
    modes[mode].pnl.actual = performance(buckets[mode].actual);
    modes[mode].pnl.allClassified = performance([...buckets[mode].estimated, ...buckets[mode].actual]);
  }
  return { modes, duplicateRecords, invalidRecords, excludedLegacyRecords };
}

function metricLines(label: string, result: PerformanceSummary): string[] {
  const pf = result.profitFactor === null
    ? result.grossProfit > 0 ? 'tidak terdefinisi (belum ada rugi)' : 'N/A'
    : result.profitFactor.toFixed(3);
  return [
    `${label}: n=${result.count}, net=${result.netPnl.toFixed(4)} USDT`,
    `  Win/loss/impas: ${result.wins}/${result.losses}/${result.breakeven}; win rate: ${result.winRatePct === null ? 'N/A' : result.winRatePct.toFixed(1) + '%'}`,
    `  Profit factor: ${pf}; max drawdown terealisasi: ${result.maxDrawdown.toFixed(4)} USDT`,
  ];
}

export function renderReport(report: ReturnType<typeof summarizeLedger>): string {
  const lines = ['LAPORAN VALIDASI OFFLINE PREDICT.FUN', ''];
  for (const mode of ['paper', 'live'] as const) {
    const summary = report.modes[mode];
    lines.push(`${mode.toUpperCase()}: ${summary.records} record, ${summary.completed} posisi selesai, ${summary.pending} belum selesai`,
      `Filled=${summary.filled}; cancelled=${summary.cancelled}; perlu rekonsiliasi=${summary.uncertain}; resolved tidak terverifikasi=${summary.incompleteResolved}`,
      ...metricLines('PnL estimasi biaya', summary.pnl.estimated),
      ...metricLines('PnL bertanda pnlIsEstimate=false', summary.pnl.actual),
      ...metricLines('Gabungan PnL terklasifikasi (termasuk estimasi)', summary.pnl.allClassified),
      `Dikecualikan dari metrik: PnL tanpa klasifikasi=${summary.pnl.unclassifiedCount}, PnL hilang=${summary.pnl.missingCount}, waktu resolusi hilang=${summary.missingResolutionTime}`, '');
  }
  lines.push(`Legacy/mode tidak diketahui dikecualikan: ${report.excludedLegacyRecords}; duplikat: ${report.duplicateRecords}; record invalid: ${report.invalidRecords}`,
    'Mode paper adalah simulasi. Flag PnL bukan bukti audit rekening/receipt; laporan ini tidak memverifikasi transaksi on-chain.',
    'Drawdown hanya dari PnL posisi selesai, mulai equity 0; tidak mencakup floating loss, deposit, penarikan, atau modal awal.',
    'Jumlah sampel kecil dapat menyesatkan. Hasil historis/estimasi tidak membuktikan profit live atau profit masa depan.');
  return lines.join('\n');
}

export function runReport(args: string[]): number {
  if (args.length > 1 || args.includes('--help') || args.includes('-h')) {
    console.log('Pemakaian: npm run paper:report -- [path-ledger.json]');
    return args.length > 1 ? 1 : 0;
  }
  const filename = path.resolve(args[0] || 'data/verified_arbitrage_trades.json');
  if (!fs.existsSync(filename)) {
    console.log('Belum ada data validasi. Jalankan paper trading dahulu; ledger baru belum tersedia.');
    return 0;
  }
  try {
    console.log(renderReport(summarizeLedger(JSON.parse(fs.readFileSync(filename, 'utf8')))));
    return 0;
  } catch (error) {
    console.error(`Laporan gagal: ${error instanceof Error ? error.message : 'ledger tidak dapat dibaca'}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runReport(process.argv.slice(2));
}
