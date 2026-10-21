import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as sdk from '../dist/index.js';
import { Transport } from '../dist/transport.js';
import { buildEvent } from '../dist/event.js';
import { NodeStore } from '../dist/node-store.js';
import { listen, body } from './helpers.mjs';
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'tinytrace-outbox-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function files(dir) { return (await readdir(dir)).filter(f => f.endsWith('.json')); }
async function waitFor(check, timeout = 2000) { const until = Date.now() + timeout; while (!await check()) { if (Date.now() > until) throw Error('Timed out'); await delay(5); } }

test('a hard-killed process replays a persisted, sanitized event with its original ID', async t => {
  const dir = await directory(t), events = []; let offline = true;
  const endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.writeHead(offline ? 503 : 202); res.end(); });
  const code = `import * as sdk from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    sdk.init({endpoint:${JSON.stringify(endpoint)},globalHandlers:false,durable:{directory:${JSON.stringify(dir)},retryInterval:10},maxRetries:0,redaction:{values:['CUSTOMER-4711']}});
    const id=await sdk.captureExceptionAsync(Error('failure CUSTOMER-4711 password=private-value')); if(!id)process.exit(2);
    console.log('READY '+id); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', stderr = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  await waitFor(() => /READY [a-f0-9]{32}/.test(output) || child.exitCode !== null);
  assert.match(output, /READY [a-f0-9]{32}/, stderr); const id = /READY ([a-f0-9]{32})/.exec(output)[1];
  child.kill('SIGKILL'); await once(child, 'close');
  const saved = await files(dir); assert.equal(saved.length, 1);
  const content = await readFile(join(dir, saved[0]), 'utf8'); assert.doesNotMatch(content, /CUSTOMER-4711|private-value/);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, saved[0]))).mode & 0o777, 0o600);
  offline = false; await delay(20);
  sdk.init({ endpoint, globalHandlers: false, durable: { directory: dir, retryInterval: 10 }, maxRetries: 0 });
  assert.equal(await sdk.flush(), true); assert.ok(events.some(e => e.event_id === id)); assert.equal(sdk.getStats().replayed, 1);
  assert.equal(await sdk.close(), true); assert.equal((await files(dir)).length, 0);
});
test('transient retry exhaustion retains data and successful later delivery acknowledges it', async t => {
  const dir = await directory(t); let offline = true, calls = 0;
  const endpoint = await listen(t, async (req, res) => { await body(req); calls++; res.writeHead(offline ? 503 : 200); res.end(); });
  const tx = new Transport(new URL(endpoint), { endpoint, durable: { directory: dir, retryInterval: 50 }, maxRetries: 0 }); t.after(() => tx.shutdown());
  assert.equal(tx.enqueue(buildEvent('retained', false)), true); assert.equal(await tx.persist(), true);
  await waitFor(() => tx.deferred > 0); assert.equal(tx.dropped, 0); assert.equal((await files(dir)).length, 1);
  assert.equal(await tx.flush(5), false); offline = false; assert.equal(await tx.flush(1000), true);
  assert.ok(calls >= 2); assert.equal(tx.sent, 1); assert.equal((await files(dir)).length, 0);
});
test('Retry-After survives shutdown and restart without sending early', async t => {
  const dir = await directory(t); let calls = 0;
  const endpoint = await listen(t, async (req, res) => { await body(req); calls++; res.writeHead(429, { 'retry-after': '60' }); res.end(); });
  const options = { endpoint, durable: { directory: dir, retryInterval: 10 }, maxRetries: 0 };
  const first = new Transport(new URL(endpoint), options); first.enqueue(buildEvent('limited', false)); await first.persist();
  await waitFor(() => first.deferred === 1); await first.shutdown(); const before = calls;
  const second = new Transport(new URL(endpoint), options); t.after(() => second.shutdown());
  assert.equal(await second.flush(40), false); assert.equal(calls, before); assert.equal(second.pending, 1);
});
test('permanent rejection is removed while outbox capacity is reported without throwing', async t => {
  const dir = await directory(t);
  const endpoint = await listen(t, (_req, res) => { res.writeHead(400); res.end(); });
  const tx = new Transport(new URL(endpoint), { endpoint, durable: { directory: dir, maxEvents: 1 }, maxRetries: 0 }); t.after(() => tx.shutdown());
  assert.equal(tx.enqueue(buildEvent('first', false)), true); assert.equal(tx.enqueue(buildEvent('overflow', false)), false);
  assert.equal(await tx.flush(), false); assert.equal((await files(dir)).length, 0); assert.equal(tx.dropped, 2);
});
test('destination mismatch and a second live owner fail closed without deleting events', async t => {
  const dir = await directory(t), destination = 'http://localhost/original';
  const first = new NodeStore({ directory: dir }, destination); await first.load();
  const event = buildEvent('private tenant', false), record = { id: event.event_id, body: JSON.stringify(event), created: Date.now(), due: 0 };
  await first.put(record);
  const competing = new NodeStore({ directory: dir }, destination); await assert.rejects(competing.load(), /live owner/); await competing.close();
  await first.close();
  const wrong = new NodeStore({ directory: dir }, 'http://localhost/other'); await assert.rejects(wrong.load(), /another destination/); await wrong.close();
  assert.equal((await files(dir)).length, 1);
  const recovered = new NodeStore({ directory: dir }, destination); assert.equal((await recovered.load())[0].id, record.id); await recovered.close();
});
test('corrupt, expired and symlink records are discarded without reading external data', async t => {
  const dir = await directory(t), destination = 'http://localhost/events';
  let store = new NodeStore({ directory: dir }, destination); await store.load(); await store.close();
  await writeFile(join(dir, 'a'.repeat(32) + '.json'), '{truncated');
  const event = buildEvent('expired', false); await writeFile(join(dir, event.event_id + '.json'), JSON.stringify({ id: event.event_id, body: JSON.stringify(event), created: 1, due: 0 }));
  const external = join(dir, 'external.txt'); await writeFile(external, 'keep this file');
  if (process.platform !== 'win32') await symlink(external, join(dir, 'b'.repeat(32) + '.json'));
  store = new NodeStore({ directory: dir }, destination); assert.deepEqual(await store.load(), []); await store.close();
  assert.equal(await readFile(external, 'utf8'), 'keep this file'); assert.equal((await files(dir)).length, 0);
});
test('disk byte limits cause observable persistence failure and no network transmission', async t => {
  const dir = await directory(t); let calls = 0;
  const endpoint = await listen(t, (_req, res) => { calls++; res.end(); });
  const tx = new Transport(new URL(endpoint), { endpoint, durable: { directory: dir, maxBytes: 1024 } }); t.after(() => tx.shutdown());
  tx.enqueue(buildEvent('x'.repeat(2048), false)); assert.equal(await tx.persist(), false);
  assert.equal(tx.stats().storageErrors, 1); assert.equal(await tx.flush(), false); assert.equal(calls, 0);
});
test('lowering recovery capacity preserves existing valid events instead of silently deleting them', async t => {
  const dir = await directory(t), destination = 'http://localhost/events';
  const first = new NodeStore({ directory: dir }, destination); await first.load();
  for (const message of ['one', 'two']) { const event = buildEvent(message, false); await first.put({ id: event.event_id, body: JSON.stringify(event), created: Date.now(), due: 0 }); }
  await first.close();
  const smaller = new NodeStore({ directory: dir, maxEvents: 1 }, destination); await assert.rejects(smaller.load(), /configured limits/); await smaller.close();
  assert.equal((await files(dir)).length, 2);
});
test('runtime retention expires an indefinitely deferred event', async t => {
  const dir = await directory(t), endpoint = await listen(t, (_req, res) => { res.writeHead(429, { 'retry-after': '9'.repeat(400) }); res.end(); });
  const tx = new Transport(new URL(endpoint), { endpoint, durable: { directory: dir, maxAge: 1000 }, maxRetries: 0 }); t.after(() => tx.shutdown());
  tx.enqueue(buildEvent('eventually expired', false)); await tx.persist();
  assert.equal(await tx.flush(2000), false); assert.equal(tx.dropped, 1); assert.equal(tx.pending, 0); assert.equal((await files(dir)).length, 0);
});
