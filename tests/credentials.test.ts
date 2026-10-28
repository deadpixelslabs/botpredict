import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { credentialProofId, credentialsFromEnvironment, getSecretStatus, sealCredentials, unsealCredentials, validateCredentials, validateSealedCredentials } from '../server/credentials';

const key = '01'.repeat(32); // Synthetic, never funded or used on a network.
const input = { predictFunApiKey: 'synthetic-predict-key', walletPrivateKey: key, predictAccountAddress: '' };
const passwordEnv = { BOT_CONTROL_TOKEN: 'synthetic-operator-password-at-least-24-characters' };
const dedicatedEnv = { BOT_CREDENTIALS_KEY: 'a1'.repeat(32) };

test('seals normalized credentials with fresh randomness and no plaintext fields', () => {
  const a = sealCredentials(input, passwordEnv), b = sealCredentials(input, passwordEnv);
  assert.deepEqual(Object.keys(a).sort(), ['algorithm','ciphertext','iv','salt','tag','version']);
  assert.notDeepEqual(a,b);
  const json = JSON.stringify(a);
  assert.equal(json.includes(input.predictFunApiKey),false); assert.equal(json.includes(input.walletPrivateKey),false);
  const plain = unsealCredentials(a,passwordEnv);
  assert.equal(plain.walletPrivateKey,`0x${key}`); assert.equal(plain.walletAddress,new Wallet(`0x${key}`).address);
  assert.equal(plain.predictAccountAddress,''); assert.equal(plain.predictFunApiKey,input.predictFunApiKey);
});
test('dedicated 32-byte key takes priority; password rotation then does not change the key', () => {
  const encrypted = sealCredentials(input,{...dedicatedEnv,...passwordEnv});
  assert.equal(unsealCredentials(encrypted,{...dedicatedEnv,BOT_CONTROL_TOKEN:'a totally different long operator password'}).walletPrivateKey,`0x${key}`);
  assert.throws(() => unsealCredentials(encrypted,passwordEnv),(e:any)=>e.code==='DECRYPTION_FAILED');
});
test('wrong password, key or authenticated envelope bytes cannot silently fall back to environment credentials', () => {
  const encrypted = sealCredentials(input,passwordEnv);
  const wrongEnv = {BOT_CONTROL_TOKEN:'different-operator-password-at-least-24',PREDICT_FUN_API_KEY:'other-api-key',WALLET_PRIVATE_KEY:'02'.repeat(32)};
  assert.throws(()=>unsealCredentials(encrypted,wrongEnv),(e:any)=>e.code==='DECRYPTION_FAILED'&&!e.message.includes(key));
  for (const field of ['salt','iv','tag','ciphertext'] as const) {
    const bytes=Buffer.from(encrypted[field],'base64'); bytes[0]^=1;
    assert.throws(()=>unsealCredentials({...encrypted,[field]:bytes.toString('base64')},passwordEnv),(e:any)=>e.code==='DECRYPTION_FAILED');
  }
});
test('rejects weak/invalid encryption configuration and malformed envelopes without echoing secrets', () => {
  for (const env of [{},{BOT_CONTROL_TOKEN:'short'},{BOT_CREDENTIALS_KEY:'not-valid-secret-material'}]) assert.throws(()=>sealCredentials(input,env),(e:any)=>e.code==='KEY_NOT_CONFIGURED'&&!e.message.includes(input.predictFunApiKey));
  const encrypted=sealCredentials(input,dedicatedEnv);
  for (const envelope of [null,{...encrypted,version:2},{...encrypted,algorithm:'aes-256-cbc'},{...encrypted,iv:'garbage!'},{...encrypted,tag:Buffer.alloc(8).toString('base64')},{...encrypted,walletPrivateKey:key}]) assert.throws(()=>validateSealedCredentials(envelope),(e:any)=>e.code==='INVALID_ENVELOPE');
});
test('validates private signing key and addresses locally, supports an empty smart account for EOA', () => {
  for (const value of [{...input,walletPrivateKey:'00'.repeat(32)},{...input,walletPrivateKey:'ff'.repeat(32)},{...input,predictFunApiKey:'short'},{...input,predictFunApiKey:'valid key with spaces'},{...input,predictAccountAddress:'not-an-address'}]) assert.throws(()=>validateCredentials(value),(e:any)=>e.code==='INVALID_INPUT');
  const account='0x0000000000000000000000000000000000000123';
  const plain=validateCredentials({...input,predictAccountAddress:account}); assert.equal(plain.predictAccountAddress,account);
  const status=getSecretStatus(plain);
  assert.deepEqual(status,{predictFunApiKeyConfigured:true,walletPrivateKeyConfigured:true,predictAccountAddressConfigured:true,walletAddress:account});
  assert.deepEqual(getSecretStatus(),{predictFunApiKeyConfigured:false,walletPrivateKeyConfigured:false,predictAccountAddressConfigured:false,walletAddress:null});
  assert.equal(JSON.stringify(status).includes(key),false); assert.equal(JSON.stringify(status).includes(input.predictFunApiKey),false);
});
test('environment compatibility derives the EOA signer and treats incomplete bundles as unavailable', () => {
  assert.equal(credentialsFromEnvironment({}),null);
  assert.equal(credentialsFromEnvironment({PREDICT_FUN_API_KEY:input.predictFunApiKey}),null);
  const value=credentialsFromEnvironment({PREDICT_FUN_API_KEY:input.predictFunApiKey,WALLET_PRIVATE_KEY:key});
  assert.equal(value!.walletAddress,new Wallet(`0x${key}`).address);
});

test('PAPER API-only credentials round trip encrypted without implying a signer or live auth proof', () => {
  const paper = {predictFunApiKey:'synthetic-paper-market-key',walletPrivateKey:'',predictAccountAddress:''};
  const normalized = validateCredentials(paper);
  assert.deepEqual(normalized,{...paper,walletAddress:''});
  assert.deepEqual(validateCredentials({predictFunApiKey:paper.predictFunApiKey}),normalized);
  const encrypted = sealCredentials(paper,dedicatedEnv);
  assert.ok(!JSON.stringify(encrypted).includes(paper.predictFunApiKey));
  assert.deepEqual(unsealCredentials(encrypted,dedicatedEnv),normalized);
  assert.deepEqual(getSecretStatus(normalized),{predictFunApiKeyConfigured:true,walletPrivateKeyConfigured:false,predictAccountAddressConfigured:false,walletAddress:null});
  assert.throws(()=>credentialProofId(normalized,passwordEnv),(error:any)=>error.code==='INVALID_INPUT');
  assert.throws(()=>validateCredentials({...paper,predictAccountAddress:'0x0000000000000000000000000000000000000123'}),(error:any)=>error.code==='INVALID_INPUT');
  assert.throws(()=>validateCredentials({...paper,walletPrivateKey:'0x'}),(error:any)=>error.code==='INVALID_INPUT');
});
