import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLimitOrderInput, summarizePredictOrder } from '../server/predictClient';

const E = 10n ** 18n;
test('BUY rounds down to the market tick and reserves fees within budget', () => {
    const r = calculateLimitOrderInput(0.5, 0.6379, 'BUY', 3, 200);
    assert.equal(r.pricePerShareWei, 637000000000000000n);
    const principal = r.pricePerShareWei * r.quantityWei / E;
    assert.ok(principal + (principal * 200n + 9999n) / 10000n <= r.amountWei);
});
test('SELL preserves a minimum price and never creates shares', () => {
    const r = calculateLimitOrderInput(1.234567, 0.6371, 'SELL', 3, 200);
    assert.equal(r.pricePerShareWei, 638000000000000000n);
    assert.equal(r.quantityWei, 1234567000000000000n);
    assert.throws(() => calculateLimitOrderInput(0.001, 0.5, 'SELL', 2, 200), /below 0.01/);
});
test('rejects invalid amounts and market metadata instead of silently clamping', () => {
    for (const amount of [0, -1, NaN, Infinity]) assert.throws(() => calculateLimitOrderInput(amount, 0.5, 'BUY', 2, 200));
    for (const price of [0, 1, NaN, Infinity]) assert.throws(() => calculateLimitOrderInput(1, price, 'BUY', 2, 200));
    assert.throws(() => calculateLimitOrderInput(1, 0.5, 'BUY', undefined as any, 200));
    assert.throws(() => calculateLimitOrderInput(1, 0.5, 'BUY', 2, undefined as any));
});
test('99.9% fill remains partial; no fabricated half-fill from status', () => {
    const r = summarizePredictOrder({ status:'OPEN', amount:'1000000000000000000000', amountFilled:'999000000000000000000' });
    assert.equal(r.filled, false);
    assert.equal(r.filledRatio, 0.999);
    assert.equal(r.filledQuantity, 999);
    const unknown = summarizePredictOrder({ status:'FILLED_PARTIALLY' });
    assert.equal(unknown.filledRatio, 0);
    assert.equal(unknown.uncertain, true);
});
test('explicit zero fill is authoritative even if remaining amount is stale', () => {
    const r = summarizePredictOrder({ status:'OPEN', amount:'100', amountFilled:'0', remainingTakerAmount:'0', order:{takerAmount:'100'} });
    assert.equal(r.filled, false);
    assert.equal(r.filledRatio, 0);
});
test('absence and cancellations never become a fictitious full fill', () => {
    assert.equal(summarizePredictOrder(null).status, 'UNKNOWN');
    assert.equal(summarizePredictOrder(null).cancelConfirmed, false);
    const r = summarizePredictOrder({ status:'CANCELLED', amount:'10000000000000000000', amountFilled:'2500000000000000000' });
    assert.equal(r.cancelConfirmed, true);
    assert.equal(r.filled, false);
    assert.equal(r.filledRatio, 0.25);
});
test('limit price from signed amounts is not reported as average execution price', () => {
    const r = summarizePredictOrder({status:'FILLED',amount:'10000000000000000000',amountFilled:'10000000000000000000',order:{side:0,makerAmount:'6500000000000000000',takerAmount:'10000000000000000000'}});
    assert.equal(r.limitPrice,0.65);
    assert.equal(r.averageFillPrice,undefined);
    assert.equal(r.filledQuantity,10);
});

test('one wei unfilled cannot round into a full fill', () => {
    const r = summarizePredictOrder({status:'OPEN',amount:'1000000000000000000',amountFilled:'999999999999999999'});
    assert.equal(r.filled,false);
    assert.ok(r.filledRatio < 1);
});
