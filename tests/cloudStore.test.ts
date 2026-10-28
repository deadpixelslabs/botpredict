import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, CloudStoreError, cloudStorageConfigured, type BlobJsonAdapter } from '../server/cloudStore';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { sealCredentials, unsealCredentials } from '../server/credentials';

const trade = (id: string) => ({ id, timestamp: 100000, amount: 1, mode: 'paper' });

class MemoryBlob implements BlobJsonAdapter {
  record: { value: any; etag: string } | null = null;
  writes = 0;
  beforeWrite?: () => Promise<void>;
  async read() { return this.record ? structuredClone(this.record) : null; }
  async write(_path: string, value: any, options: { ifMatch?: string; createOnly?: boolean }) {
    if (this.beforeWrite) { const hook = this.beforeWrite; this.beforeWrite = undefined; await hook(); }
    if (options.createOnly && this.record || options.ifMatch && options.ifMatch !== this.record?.etag) throw Object.assign(new Error('conflict'), { status: 412 });
    this.record = { value: structuredClone(value), etag: `etag-${++this.writes}` };
    return { etag: this.record.etag };
  }
}
function fixture() {
  const blob = new MemoryBlob(); let now = 100000;
  const a = new CloudStore(blob, { now: () => now });
  const b = new CloudStore(blob, { now: () => now });
  return { blob, a, b, advance(ms: number) { now += ms; } };
}

test('missing storage is inert paper state; reads do not initialize or expose internal lease', async () => {
  const { a, blob } = fixture();
  const state = await a.readState();
  assert.equal(state.config.isPaperTrading, true); assert.equal(state.config.enableAutoTrade, false);
  assert.equal(blob.writes, 0);
  await a.acquireLease('worker-a');
  assert.equal('lease' in await a.readState(), false);
  assert.equal(cloudStorageConfigured({}), false);
  assert.equal(cloudStorageConfigured({ BLOB_STORE_ID: 'store_abc' }), true);
});
test('only one worker can acquire, renew and mutate with the active lease', async () => {
  const { a, b, advance } = fixture();
  const results = await Promise.all([a.acquireLease('worker-a'), b.acquireLease('worker-b')]);
  assert.deepEqual([...results].sort(), [false, true]);
  // Acquisition attempts above are concurrent; identify the winner from a guarded write.
  let winning = 'worker-a';
  try { await a.assertLease(winning); } catch { winning = 'worker-b'; }
  const other = winning === 'worker-a' ? 'worker-b' : 'worker-a';
  await assert.rejects(a.mutateState(state => { state.ledger.push(trade('invalid')); }, other), (e: any) => e.code === 'LEASE_LOST');
  await a.mutateState(state => { state.ledger.push(trade('valid')); }, winning);
  advance(20000); await a.renewLease(winning); await a.assertLease(winning);
  assert.equal((await b.readState()).ledger.length, 1);
});
test('expiry allows takeover; the old worker cannot write or submit after takeover', async () => {
  const { a, b, advance } = fixture();
  await a.acquireLease('worker-a'); advance(45001);
  assert.equal(await b.acquireLease('worker-b'), true);
  await assert.rejects(a.assertLease('worker-a'), (e: any) => e.code === 'LEASE_LOST');
  await assert.rejects(a.mutateState(state => { state.ledger.push(trade('old-worker')); }, 'worker-a'), (e: any) => e.code === 'LEASE_LOST');
  await a.releaseLease('worker-a'); // Cannot release the new owner's lease.
  await b.assertLease('worker-b');
});
test('a stale write racing takeover fails by the same-document ETag and never replaces the new owner', async () => {
  const { a, b, blob, advance } = fixture();
  await a.acquireLease('worker-a');
  blob.beforeWrite = async () => { advance(45001); assert.equal(await b.acquireLease('worker-b'), true); };
  await assert.rejects(a.mutateState(state => { state.ledger.push(trade('stale')); }, 'worker-a'), (e: any) => e.code === 'LEASE_LOST');
  assert.equal((await b.readState()).ledger.length, 0); await b.assertLease('worker-b');
});
test('concurrent control command and worker ledger update preserve both changes via CAS retry', async () => {
  const { a, b } = fixture(); await a.acquireLease('worker-a');
  await Promise.all([
    a.mutateState(state => { state.ledger.push(trade('trade-1')); }, 'worker-a'),
    b.mutateState(state => { state.commands.push({ id: 'command-1', type: 'clearLogs', createdAt: 100001, status: 'pending' }); }),
  ]);
  const state = await a.readState(); assert.equal(state.ledger.length, 1); assert.equal(state.commands.length, 1);
});
test('corrupt data is never replaced by defaults or a lease acquisition', async () => {
  const { a, blob } = fixture(); blob.record = { value: { schemaVersion: 999 }, etag: 'broken' };
  await assert.rejects(a.readState(), (e: any) => e.code === 'CORRUPT_STATE');
  await assert.rejects(a.acquireLease('worker-a'), (e: any) => e.code === 'CORRUPT_STATE');
  await assert.rejects(a.mutateState(state => { state.config.isPaperTrading = true; }), (e: any) => e.code === 'CORRUPT_STATE');
  assert.equal(blob.writes, 0);
});
test('short lease safety margin blocks live submit while allowing renewal; expired lease cannot renew', async () => {
  const { a, advance } = fixture(); await a.acquireLease('worker-a'); advance(35001);
  await assert.rejects(a.assertLease('worker-a'), (e: any) => e.code === 'LEASE_LOST');
  await a.renewLease('worker-a'); await a.assertLease('worker-a'); advance(45001);
  await assert.rejects(a.renewLease('worker-a'), (e: any) => e.code === 'LEASE_LOST');
});
test('credentials are removed from state snapshots, while public outcome token IDs remain', async () => {
  const { a } = fixture(); const original = process.env.PREDICT_FUN_API_KEY;
  process.env.PREDICT_FUN_API_KEY = 'synthetic-secret-key';
  try {
    await a.mutateState(state => {
      state.config.walletPrivateKey = 'unwanted';
      state.status = { apiKey: 'unwanted', logs: ['Bearer abc.def.token and synthetic-secret-key'] };
      state.ledger.push({ ...trade('trade-1'), tokenId: '1234', signature: 'signed-order' });
    });
    const state = await a.readState();
    assert.equal('walletPrivateKey' in state.config, false); assert.equal('apiKey' in state.status, false);
    assert.equal(state.ledger[0].tokenId, '1234'); assert.equal('signature' in state.ledger[0], false);
    assert.equal(JSON.stringify(state).includes('synthetic-secret-key'), false);
  } finally { if (original === undefined) delete process.env.PREDICT_FUN_API_KEY; else process.env.PREDICT_FUN_API_KEY = original; }
});
test('persistent CAS contention fails closed rather than overwriting an unseen state version', async () => {
  const { a, blob } = fixture(); await a.acquireLease('worker-a');
  const initial = structuredClone(blob.record);
  blob.write = async () => { throw new CloudStoreError('CONFLICT', 'busy'); };
  await assert.rejects(a.mutateState(state => { state.ledger.push(trade('uncommitted')); }, 'worker-a'), (e: any) => e.code === 'CONFLICT');
  assert.deepEqual(blob.record, initial);
});
test('a single corrupt ledger row blocks all writes and cannot reset daily loss evidence', async () => {
  for (const bad of [{ id:'bad' }, { ...trade('bad'), amount:NaN }, { ...trade('bad'), mode:'LIVE' }, { ...trade('bad'), timestamp:0 }, { ...trade('bad'), resolved:true }]) {
    const {a,blob} = fixture(); await a.acquireLease('worker-a');
    blob.record!.value.ledger = [bad]; const writes = blob.writes;
    await assert.rejects(a.readState(), (e:any) => e.code === 'CORRUPT_STATE');
    await assert.rejects(a.mutateState(state => { state.ledger = []; },'worker-a'), (e:any) => e.code === 'CORRUPT_STATE');
    assert.equal(blob.writes,writes);
  }
});
test('SDK conflict subclasses with generic Error names still trigger a safe CAS retry', async () => {
  const {a,blob} = fixture(); await a.acquireLease('worker-a');
  const write = blob.write.bind(blob); let calls = 0;
  blob.write = async (...args) => { if (calls++ === 0) throw new BlobPreconditionFailedError(); return write(...args); };
  await a.mutateState(state => { state.ledger.push(trade('retry')); },'worker-a');
  assert.equal((await a.readState()).ledger.length,1); assert.equal(calls,2);
});
test('encrypted credentials survive worker state writes and CAS retries without plaintext persistence', async () => {
  const {a,b,blob}=fixture(); await a.acquireLease('worker-a');
  const env={BOT_CREDENTIALS_KEY:'a1'.repeat(32)};
  const plaintext={predictFunApiKey:'synthetic-predict-secret',walletPrivateKey:'01'.repeat(32),predictAccountAddress:''};
  const sealed=sealCredentials(plaintext,env);
  await a.mutateState(state=>{state.sealedCredentials=sealed;state.credentialRevision=1;});
  await Promise.all([
    a.mutateState(state=>{state.ledger.push(trade('with-credentials'));state.status={heartbeatAt:100001};},'worker-a'),
    b.mutateState(state=>{state.commands.push({id:'credentials-preserved',type:'clearLogs',createdAt:100001});}),
  ]);
  const state=await a.readState(); assert.deepEqual(state.sealedCredentials,sealed);assert.equal(state.credentialRevision,1);
  assert.equal(unsealCredentials(state.sealedCredentials,env).predictFunApiKey,plaintext.predictFunApiKey);
  const stored=JSON.stringify(blob.record);
  assert.equal(stored.includes(plaintext.predictFunApiKey),false);assert.equal(stored.includes(plaintext.walletPrivateKey),false);
});
test('plaintext or malformed credential envelopes cannot be persisted and credential revision cannot roll back', async () => {
  const {a,blob}=fixture();await a.acquireLease('worker-a');
  const envelope=sealCredentials({predictFunApiKey:'synthetic-predict-secret',walletPrivateKey:'01'.repeat(32)},{BOT_CREDENTIALS_KEY:'b2'.repeat(32)});
  await assert.rejects(a.mutateState(state=>{(state as any).sealedCredentials={walletPrivateKey:'plaintext'};state.credentialRevision=1;}),(e:any)=>e.code==='CORRUPT_STATE');
  await assert.rejects(a.mutateState(state=>{(state as any).credentials={walletPrivateKey:'plaintext'};}),(e:any)=>e.code==='CORRUPT_STATE');
  await a.mutateState(state=>{state.sealedCredentials=envelope;state.credentialRevision=1;});
  await assert.rejects(a.mutateState(state=>{state.credentialRevision=0;}),(e:any)=>e.code==='CORRUPT_STATE');
  const replacement=sealCredentials({predictFunApiKey:'synthetic-other-secret',walletPrivateKey:'02'.repeat(32)},{BOT_CREDENTIALS_KEY:'b2'.repeat(32)});
  await assert.rejects(a.mutateState(state=>{state.sealedCredentials=replacement;}),(e:any)=>e.code==='CORRUPT_STATE');
  blob.record!.value.credentials={walletPrivateKey:'plaintext'};const writes=blob.writes;
  await assert.rejects(a.readState(),(e:any)=>e.code==='CORRUPT_STATE');assert.equal(blob.writes,writes);
});
