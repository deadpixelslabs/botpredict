import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfig, sameOriginRequest, validControlToken, validateControlConfig } from '../server/controlConfig';

test('rejects malformed, unsafe and secret-bearing settings', () => {
  for (const value of [null, [], {isLiveTrading: 'false'}, {maxTradeAmount: -1}, {minConfidence: NaN},
    {cooldownMs: 20}, {executionSlippage: 0.5}, {predictSyncIntervalMs: 50}, {walletPrivateKey: 'secret'}, {memoryFilePath: '/tmp/other'}]) {
    assert.throws(() => validateControlConfig(value));
  }
});
test('maps old dashboard settings and refuses contradictory aliases', () => {
  assert.deepEqual(validateControlConfig({isLiveTrading: false, maxDailyLossUsdt: 5}), {isPaperTrading: true, maxDailyLoss: 5});
  assert.throws(() => validateControlConfig({isLiveTrading: true, isPaperTrading: true}));
  assert.throws(() => validateControlConfig({betAmountUsdt: 1, maxTradeAmount: 2}));
});
test('requires explicit server live opt-in and credentials', () => {
  assert.throws(() => validateControlConfig({isPaperTrading: false}, {}));
  const env = {ENABLE_LIVE_TRADING: 'true', BOT_CONTROL_TOKEN: 'x'.repeat(32), WALLET_PRIVATE_KEY: 'new-key', PREDICT_FUN_API_KEY: 'new-api'};
  assert.deepEqual(validateControlConfig({isPaperTrading: false}, env), {isPaperTrading: false});
});
test('never publishes credentials or connection endpoints', () => {
  assert.deepEqual(publicConfig({predictFunApiKey: 'private', memoryFilePath: '/tmp/history', isPaperTrading: true, maxTradeAmount: 1} as any), {isPaperTrading: true, maxTradeAmount: 1});
});
test('auth checks and cross-origin protection', () => {
  assert.equal(validControlToken('Bearer abc', 'abc'), true);
  assert.equal(validControlToken('Bearer wrong', 'abc'), false);
  assert.equal(validControlToken(undefined, 'abc'), false);
  assert.equal(sameOriginRequest('https://attacker.example', 'localhost:3000'), false);
  assert.equal(sameOriginRequest('http://localhost:3000', 'localhost:3000'), true);
});
