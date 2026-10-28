import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// This test deliberately uses plain Node ESM, without tsx. It imports the exact
// generated file Vercel deploys, catching module-resolution errors hidden by TS loaders.
const envNames = ['BOT_CONTROL_TOKEN', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN'];
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const operator = 'synthetic-operator-native-handler-test';
process.env.BOT_CONTROL_TOKEN = operator;
delete process.env.BLOB_STORE_ID;
delete process.env.BLOB_READ_WRITE_TOKEN;
const { default: handler } = await import('../api/handler.js');
let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    // Exercise the platform's parsed-query variant in addition to URL query capture.
    if (req.headers['x-test-platform-query']) req.query = { __bot_path: req.headers['x-test-platform-query'] };
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const name of envNames) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});
async function request(path, options) {
  const response = await fetch(base + path, options);
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  return { status: response.status, body: await response.json() };
}

test('the committed native Function loads under Node ESM and serves public health', async () => {
  const result = await request('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.service, 'predict-dashboard');
});
test('rewrite destination and captured route reach the same health handler', async () => {
  assert.equal((await request('/api/handler?__bot_path=health')).status, 200);
  assert.equal((await request('/api/handler', { headers: { 'x-test-platform-query': 'health' } })).status, 200);
});
test('preserved source paths win over user-provided internal query values', async () => {
  const result = await request('/api/health?__bot_path=config');
  assert.equal(result.status, 200);
  assert.equal(result.body.service, 'predict-dashboard');
});
test('nested API paths reach authorization rather than a missing Function', async () => {
  for (const path of ['/api/logs/clear', '/api/handler?__bot_path=logs%2Fclear', '/api/arbitrage/config']) {
    const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'UNAUTHORIZED');
  }
});
test('authenticated requests expose a clear setup error when private storage is absent', async () => {
  const result = await request('/api/handler?__bot_path=config', { headers: { Authorization: `Bearer ${operator}` } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'STORAGE_NOT_CONFIGURED');
});
test('malformed rewrite captures fail closed with JSON', async () => {
  for (const capture of ['../health', 'logs//clear', 'health?x=1']) {
    const result = await request('/api/handler?__bot_path=' + encodeURIComponent(capture));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_API_PATH');
  }
  assert.equal((await request('/api/handler?__bot_path=health&__bot_path=config')).status, 400);
});
test('deployment configuration points to the generated native handler and routes nested API paths', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions['api/handler.js'].maxDuration, 30);
  assert.deepEqual(config.rewrites, [{ source: '/api/:path*', destination: '/api/handler?__bot_path=:path*' }]);
  const source = await readFile(new URL('../api/handler.js', import.meta.url), 'utf8');
  assert.ok(!/\bfrom\s+["']\.\.?\//.test(source), 'all local imports must be bundled for Node ESM');
  assert.ok(!/\bimport\s*\(\s*["']\.\.?\//.test(source), 'dynamic local imports must also be bundled');
});
