import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

// No HTTP is performed: the adapter is installed before the client is imported.
const requests: any[] = [];
let mode = 'normal';
let authCount = 0;
let orderPosts = 0;
let observedHash = '';
let removed = false;
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url')}.test`;
axios.defaults.adapter = async (config: any) => {
    requests.push(config);
    const ok = (data: any) => ({data, status:200, statusText:'OK',headers:{},config});
    if (config.url === '/auth/message') { authCount++; return ok({success:true,data:{message:'unit-test challenge'}}); }
    if (config.url === '/auth') return ok({success:true,data:{token}});
    if (config.url === '/orders') {
        orderPosts++;
        const data = JSON.parse(config.data).data;
        observedHash = data.order.hash;
        if (mode === 'timeout') throw new Error('synthetic timeout');
        return ok({success:true,data:{orderId:'test-order',orderHash:data.order.hash}});
    }
    if (config.url === '/orders/remove') { removed = true; return ok({success:true,removed:['test-order'],noop:[]}); }
    if (config.url?.startsWith('/orders/')) {
        if (mode === 'status-outage') throw new Error('synthetic outage');
        if (mode === 'partial-cancel') return ok({success:true,data:{status:removed?'CANCELLED':'OPEN',amount:'10000000000000000000',amountFilled:'2500000000000000000'}});
        return ok({success:true,data:{status:'OPEN',amount:'10000000000000000000',amountFilled:'0'}});
    }
    throw new Error(`Unexpected mock request: ${config.url}`);
};
const client = await import('../server/predictClient');
const key = `0x${'01'.repeat(32)}`; // Synthetic test key, never funded or used outside this mock.
const apiKey = 'unit-test-key';
const epoch = Math.floor(Date.now()/1000/300)*300;
const market = { id:1, categorySlug:`btc-updown-5m-${epoch}`, tradingStatus:'OPEN', decimalPrecision:3,feeRateBps:200,isNegRisk:false,isYieldBearing:false,outcomes:[{name:'Up',onChainId:'1'},{name:'Down',onChainId:'2'}] };

test('authentication and builder initialization are deduplicated across concurrent callers', async () => {
    const builders = await Promise.all(Array.from({length:5}, () => client.getOrderBuilder(key,'')));
    assert.ok(builders.every(b => b === builders[0]));
    await Promise.all(builders.map(b => client.getJwtToken(b,'',apiKey)));
    assert.equal(authCount,1);
});
test('signed limit payload retains integer units, tick precision, real TTL and budget', async () => {
    const r = await client.placePredictOrder('BULL',0.5,key,'',apiKey,0.6379,epoch,'BUY',market,market.outcomes[0]);
    const post = requests.filter(r=>r.url === '/orders').at(-1);
    const payload = JSON.parse(post.data).data;
    assert.equal(payload.pricePerShare,'637000000000000000');
    assert.equal(r.limitPrice,0.637);
    assert.ok(BigInt(payload.order.makerAmount) <= 500000000000000000n);
    assert.equal(Number(payload.order.expiration),r.expiration);
    assert.ok(r.expiration <= Math.floor(Date.now()/1000)+15);
    assert.ok(r.sharesQuantity > 0);
});
test('ambiguous POST failure exposes the signed hash and is never blindly retried', async () => {
    mode = 'timeout';
    const before = orderPosts;
    await assert.rejects(client.placePredictOrder('BULL',0.5,key,'',apiKey,0.5,epoch,'BUY',market,market.outcomes[0]), (e:any) => {
        assert.equal(e.uncertain,true);
        assert.equal(e.orderHash,observedHash);
        assert.ok(e.placement.sharesQuantity > 0);
        return true;
    });
    assert.equal(orderPosts,before+1);
    mode = 'normal';
});
test('successful offchain removal cannot imply confirmed cancellation during an outage', async () => {
    mode = 'status-outage';
    const r = await client.checkAndCancelPredictOrder(observedHash,key,'',apiKey,'test-order',0);
    assert.equal(r.status,'UNKNOWN');
    assert.equal(r.cancelConfirmed,false);
    assert.equal(r.bookRemovalConfirmed,true);
    assert.equal(r.filled,false);
    mode = 'normal';
});

test('JWT credentials are scoped by signer/account rather than a single global token', async () => {
    const before = authCount;
    await client.getJwtToken({signer:{address:'0x0000000000000000000000000000000000000123',signMessage:async()=> 'mock-signature'}},'',apiKey);
    assert.equal(authCount,before+1);
});
test('partial cancellation reports only observed filled shares', async () => {
    mode = 'partial-cancel';
    removed = false;
    const r = await client.checkAndCancelPredictOrder(observedHash,key,'',apiKey,'test-order',0);
    assert.equal(r.cancelConfirmed,true);
    assert.equal(r.filled,false);
    assert.equal(r.filledRatio,0.25);
    assert.equal(r.filledQuantity,2.5);
    assert.equal(r.onchainCancelled,false);
    mode = 'normal';
});
