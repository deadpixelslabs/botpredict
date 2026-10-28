import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import axios from 'axios';

// The adapter is installed BEFORE importing the engine/client. All HTTP is mocked;
// these synthetic credentials are never used on a network or written to .env.
const syntheticKey = `0x${'02'.repeat(32)}`;
const syntheticAddress = new Wallet(syntheticKey).address;
const envNames = ['ENABLE_LIVE_TRADING','WALLET_PRIVATE_KEY','WALLET_ADDRESS','PREDICT_ACCOUNT_ADDRESS','PREDICT_FUN_API_KEY'] as const;
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const originalAdapter = axios.defaults.adapter;
const realNow = Date.now;
const dirs: string[] = [];
let now = Math.floor(realNow() / 300000) * 300000 + 60000;
let mode: 'normal' | 'buy-timeout' = 'normal';
let orderPosts = 0;
let orderGets = 0;
let observedHash = '';
let statusFixture: any = { status:'OPEN', amount:'10000000000000000000', amountFilled:'0' };
function setCredentials() {
    process.env.ENABLE_LIVE_TRADING = 'true';
    process.env.WALLET_PRIVATE_KEY = syntheticKey;
    process.env.WALLET_ADDRESS = syntheticAddress;
    process.env.PREDICT_ACCOUNT_ADDRESS = '';
    process.env.PREDICT_FUN_API_KEY = 'synthetic-engine-live-test';
}
setCredentials();
axios.defaults.adapter = async (config: any) => {
    const ok = (data: any) => ({data,status:200,statusText:'OK',headers:{},config});
    if (config.url === '/auth/message') return ok({success:true,data:{message:'engine live test challenge'}});
    if (config.url === '/auth') {
        const token = `e30.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.test`;
        return ok({success:true,data:{token}});
    }
    if (config.url === '/orders') {
        orderPosts++;
        observedHash = JSON.parse(config.data).data.order.hash;
        if (mode === 'buy-timeout') throw new Error('synthetic submission timeout');
        return ok({success:true,data:{orderId:'synthetic-order',orderHash:observedHash}});
    }
    if (config.url?.startsWith('/orders/')) {
        orderGets++;
        if (config.url === '/orders/remove') return ok({success:true,removed:['synthetic-order'],noop:[]});
        return ok({success:true,data:statusFixture});
    }
    throw new Error(`Unexpected mocked request: ${config.url}`);
};
const { PredictFunArbitrageEngine } = await import('../server/arbitrage-engine');

beforeEach(() => {
    setCredentials();
    now = Math.floor(realNow() / 300000) * 300000 + 60000;
    Date.now = () => now;
    mode = 'normal';
    orderPosts = orderGets = 0;
    statusFixture = {status:'OPEN',amount:'10000000000000000000',amountFilled:'0'};
});
afterEach(() => {
    Date.now = realNow;
    for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
    }
    for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});
});
test.after(() => { axios.defaults.adapter = originalAdapter; });

const signal = { direction:'UP', edge:.3, confidence:.9, fairOdds:1.2, marketOdds:2.5, momentum:1, volumeSpike:true, orderBookImbalance:.8, latencyMs:10, reason:'mock live acceptance' };
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(),'predict-engine-live-')); dirs.push(dir);
    const value = new PredictFunArbitrageEngine({
        memoryFilePath:join(dir,'ledger.json'), isPaperTrading:false,
        predictFunApiKey:'synthetic-engine-live-test', maxTradeAmount:.25, debug:false
    }) as any;
    await value.historyLoad;
    const epoch = Math.floor(now/300000)*300;
    const outcomes = [{name:'Up',onChainId:'1',bestAsk:{price:.4}},{name:'Down',onChainId:'2',bestAsk:{price:.61}}];
    const market = {id:1,categorySlug:`btc-updown-5m-${epoch}`,tradingStatus:'OPEN',decimalPrecision:3,feeRateBps:200,isNegRisk:false,isYieldBearing:false,outcomes};
    value.isRunning = true;
    value.cfg.enableAutoTrade = true;
    value.currentStartPrice = 100000;
    value.currentPrice = 100020;
    value.lastPredictOdds = {upOdds:2.5,downOdds:1/.61,timestamp:now};
    value.lastUpBid = .39;
    value.lastDownBid = .6;
    value.predictMarketDetails = {epoch,market,upOutcome:outcomes[0],downOutcome:outcomes[1],book:{asks:[[.4,100]],bids:[[.39,100]]}};
    value.walletBalanceUsdt = 10;
    value.lastBalanceSyncTime = now;
    return {value,epoch};
}
function trade(epoch: number, extra: any = {}) {
    return {
        id:'synthetic-order',orderId:'synthetic-order',mode:'live',direction:'UP',
        timestamp:now-2000,amount:.25,submittedAmount:.2,submittedShares:.5,
        entryOdds:2.5,fairOdds:1.2,edge:.3,signal,targetLockTime:epoch,feeRateBps:200,
        orderHash:`0x${'ab'.repeat(32)}`,orderExpiration:Math.floor(now/1000)+15,
        isFilled:false,resolved:false,sharesQuantity:.5,reconciliationRequired:false,
        ...extra
    };
}

test('ambiguous live BUY persists its signed hash and blocks a second order submission', async () => {
    const {value} = await fixture();
    mode = 'buy-timeout';
    await value.executeTrade(signal);
    assert.equal(orderPosts,1);
    assert.equal(value.trades.length,1);
    const pending = value.trades[0];
    assert.equal(pending.mode,'live');
    assert.equal(pending.executionAccount,syntheticAddress.toLowerCase());
    assert.equal(pending.signerAddress,syntheticAddress.toLowerCase());
    assert.equal(pending.orderHash,observedHash);
    assert.match(pending.orderHash,/^0x[0-9a-f]{64}$/i);
    assert.equal(pending.submissionUncertain,true);
    assert.equal(pending.resolved,false);
    assert.equal(pending.isFilled,false);
    const saved = JSON.parse(readFileSync(value.cfg.memoryFilePath,'utf8'))[0];
    assert.equal(saved.orderHash,observedHash);
    assert.equal(saved.executionAccount,syntheticAddress.toLowerCase());
    assert.equal(saved.signerAddress,syntheticAddress.toLowerCase());
    assert.equal(saved.submissionUncertain,true);
    now += 2000;
    value.lastPredictOdds.timestamp = now;
    await value.executeTrade(signal);
    assert.equal(orderPosts,1,'an unknown accepted/rejected outcome cannot permit duplicate risk');
});

test('partial BUY cancellation stays pending before signed expiry, then uses observed fill ratio', async () => {
    const {value,epoch} = await fixture();
    const pending = trade(epoch,{submissionUncertain:true});
    value.trades = [pending];
    statusFixture = {status:'CANCELLED',amount:'10000000000000000000',amountFilled:'2500000000000000000'};
    await value.checkLiveOrderFills();
    assert.ok(orderGets > 0);
    assert.equal(pending.isFilled,false,'offchain cancellation cannot release a still-valid signed order');
    assert.equal(pending.resolved,false);
    assert.equal(pending.submissionUncertain,true);
    assert.equal(pending.amount,.25);
    now += 17000;
    await value.checkLiveOrderFills();
    assert.equal(pending.isFilled,true);
    assert.equal(pending.submissionUncertain,false);
    assert.equal(pending.resolved,false,'partially bought shares remain an open position');
    assert.ok(Math.abs(pending.amount-(.2*.25*1.02))<1e-12);
    assert.ok(pending.sharesQuantity>0 && pending.sharesQuantity<.5);
    assert.equal(pending.isSharesSynced,false,'sellable shares require a portfolio reconciliation');
});

test('partial SELL preserves original cost, accumulated proceeds and remaining shares exactly once', async () => {
    const {value,epoch} = await fixture();
    const open = trade(epoch,{
        amount:3,isFilled:true,sharesQuantity:10,isSharesSynced:true,soldProceeds:.8,
        isSellOrderPlaced:true,sellSubmittedShares:10,sellOrderTimestamp:now-10000,
        sellOrderHash:`0x${'cd'.repeat(32)}`,sellOrderId:'synthetic-sell',
        sellPrice:.6,sellExpiration:Math.floor(now/1000)-2
    });
    value.trades = [open];
    statusFixture = {status:'CANCELLED',amount:'10000000000000000000',amountFilled:'2500000000000000000'};
    await value.checkLiveSellFills();
    assert.equal(open.sharesQuantity,7.5);
    assert.ok(Math.abs(open.soldProceeds-(.8+2.5*.6*.98))<1e-12);
    assert.equal(open.amount,3,'cost basis must not shrink after a partial sale');
    assert.equal(open.resolved,false);
    assert.equal(open.isSellOrderPlaced,false);
    assert.equal(open.sellOrderHash,undefined);
    const proceeds = open.soldProceeds;
    now += 2000;
    await value.checkLiveSellFills();
    assert.equal(open.soldProceeds,proceeds,'the same partial receipt cannot be counted twice');
});

test('missing credentials never turn pending live buys or sells into fictitious fills', async () => {
    const {value,epoch} = await fixture();
    const buy = trade(epoch);
    const sell = trade(epoch,{id:'pending-sell',isFilled:true,isSellOrderPlaced:true,sellOrderHash:`0x${'ef'.repeat(32)}`,sellOrderTimestamp:now-10000,sellSubmittedShares:1});
    value.trades = [buy,sell];
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.WALLET_ADDRESS;
    delete process.env.PREDICT_ACCOUNT_ADDRESS;
    const before = JSON.stringify(value.trades);
    await value.checkLiveOrderFills();
    await value.checkLiveSellFills();
    assert.equal(JSON.stringify(value.trades),before);
    assert.equal(orderGets,0);
    value.trades = [];
    await value.executeTrade(signal);
    assert.equal(value.trades.length,0);
    assert.equal(orderPosts,0);
});
