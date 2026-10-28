import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLedger, performance, renderReport } from '../scripts/paper-report';

const trade = (id: string, pnl: number, resolvedAt: number, extra: Record<string, unknown> = {}) => ({
  id, mode: 'paper', isFilled: true, resolved: true, pnlIsEstimate: true, pnl, resolvedAt, ...extra,
});

test('report separates modes and estimated/actual PnL; unknown legacy cannot prove live profit', () => {
  const report = summarizeLedger([
    trade('paper-est', 2, 1000), trade('paper-actual-flag', 1, 2000, { pnlIsEstimate: false }),
    trade('live', -1, 3000, { mode: 'live' }), trade('Paper_legacy', 999, 4000, { mode: undefined }),
    trade('unknown', 888, 5000, { mode: 'unknown' }),
    trade('unclassified', 10, 6000, { pnlIsEstimate: undefined }),
  ]);
  assert.equal(report.modes.paper.pnl.estimated.netPnl, 2);
  assert.equal(report.modes.paper.pnl.actual.netPnl, 1);
  assert.equal(report.modes.paper.pnl.allClassified.netPnl, 3);
  assert.equal(report.modes.paper.pnl.unclassifiedCount, 1);
  assert.equal(report.modes.live.pnl.estimated.netPnl, -1);
  assert.equal(report.excludedLegacyRecords, 2);
  assert.equal(report.modes.unknown.pnl.allClassified.count, 0);
});

test('profit factor and drawdown use chronological resolution, including loss from starting equity zero', () => {
  const result = performance([
    { pnl: -4, timestamp: 4000 }, { pnl: 5, timestamp: 3000 },
    { pnl: -3, timestamp: 2000 }, { pnl: -2, timestamp: 1000 }, { pnl: 0, timestamp: 5000 },
  ]);
  assert.equal(result.netPnl, -4);
  assert.equal(result.grossProfit, 5);
  assert.equal(result.grossLoss, 9);
  assert.equal(result.profitFactor, 5 / 9);
  assert.equal(result.maxDrawdown, 5);
  assert.equal(result.breakeven, 1);
  assert.equal(result.winRatePct, 20);
});

test('cancelled, uncertain, unfilled and invalid PnL cannot inflate performance', () => {
  const report = summarizeLedger([
    trade('cancelled', 10, 1000, { isCancelled: true }),
    trade('uncertain', 20, 2000, { submissionUncertain: true }),
    trade('not-filled', 30, 3000, { isFilled: false }),
    trade('pending', 40, 4000, { resolved: false }),
    trade('no-pnl', NaN, 5000), trade('no-time', 50, 0),
    trade('real', -1, 6000), trade('real', 999, 7000), null, {},
  ]);
  const paper = report.modes.paper;
  assert.equal(paper.pnl.allClassified.netPnl, -1);
  assert.equal(paper.pnl.allClassified.count, 1);
  assert.equal(paper.cancelled, 1);
  assert.equal(paper.uncertain, 1);
  assert.equal(paper.incompleteResolved, 2);
  assert.equal(paper.pending, 1);
  assert.equal(paper.pnl.missingCount, 1);
  assert.equal(paper.missingResolutionTime, 1);
  assert.equal(report.duplicateRecords, 1);
  assert.equal(report.invalidRecords, 2);
});

test('empty or no-loss report does not invent a finite profit factor or evidence of future profit', () => {
  assert.equal(performance([]).profitFactor, null);
  assert.equal(performance([]).winRatePct, null);
  const text = renderReport(summarizeLedger([trade('winner', 1, 1000)]));
  assert.match(text, /belum ada rugi/);
  assert.match(text, /tidak membuktikan profit live/);
  assert.throws(() => summarizeLedger({}), /array JSON/);
});
