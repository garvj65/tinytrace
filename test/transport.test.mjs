import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../dist/transport.js';
import { buildEvent } from '../dist/event.js';
import { listen, body } from './helpers.mjs';
const event = () => buildEvent('test', false);
function transport(t, endpoint, options = {}) {
  const tx = new Transport(new URL(endpoint), { endpoint, baseDelay: 2, requestTimeout: 100, ...options });
  t.after(() => tx.stop()); return tx;
}
test('batches and retries HTTP failures with stable IDs, exponential backoff, and Retry-After', async t => {
  const batches = [], delays = [];
  const endpoint = await listen(t, async (req, res) => {
    batches.push(await body(req));
    res.writeHead(batches.length < 3 ? 503 : 202); res.end();
  });
  t.mock.method(Math, 'random', () => 0.5);
  const tx = transport(t, endpoint, { batchSize: 2, baseDelay: 100 }); tx.delay = async ms => { delays.push(ms); };
  tx.enqueue(event()); tx.enqueue(event()); assert.equal(await tx.flush(), true);
  assert.deepEqual(delays, [100, 200]); assert.equal(batches[0].events.length, 2);
  assert.deepEqual(batches[0], batches[2]); assert.equal(tx.sent, 2);
  const limited = transport(t, endpoint, { maxDelay: 300 }); const waits = []; let calls = 0;
  limited.post = async () => ({ status: ++calls === 1 ? 429 : 200, retryAfter: 1000 });
  limited.delay = async ms => { waits.push(ms); }; limited.enqueue(event());
  assert.equal(await limited.flush(), false); assert.deepEqual(waits, []); assert.equal(calls, 1);
});
test('permanent 400 is dropped once; retry budget is finite; overflow drops newest', async t => {
  let calls = 0;
  const endpoint = await listen(t, (_req, res) => { calls++; res.writeHead(400); res.end(); });
  const tx = transport(t, endpoint, { maxQueue: 2 });
  assert.equal(tx.enqueue(event()), true); assert.equal(tx.enqueue(event()), true); assert.equal(tx.enqueue(event()), false);
  assert.equal(await tx.flush(), false); assert.equal(calls, 1); assert.equal(tx.dropped, 3);
  const retry = transport(t, endpoint, { maxRetries: 2 }); let tries = 0;
  retry.post = async () => { tries++; return { status: 500, retryAfter: 0 }; };
  retry.enqueue(event()); assert.equal(await retry.flush(), false); assert.equal(tries, 3);
});
test('in-flight entries count toward capacity and requests stay serial', async t => {
  let release, mark; const started = new Promise(r => { mark = r; });
  const endpoint = await listen(t, async (req, res) => { await body(req); release = () => res.end(); mark(); });
  const tx = transport(t, endpoint, { maxQueue: 1, batchSize: 1, requestTimeout: 2000 });
  tx.enqueue(event()); const flushed = tx.flush(); await started;
  assert.equal(tx.enqueue(event()), false); assert.equal(tx.pending, 1); release();
  assert.equal(await flushed, false); assert.equal(tx.sent, 1);
});
test('total request deadline handles hangs and close cancels work', async t => {
  const endpoint = await listen(t, () => {});
  const tx = transport(t, endpoint, { requestTimeout: 25, maxRetries: 0 });
  tx.enqueue(event()); assert.equal(await tx.flush(1000), false); assert.equal(tx.dropped, 1);
  const pending = transport(t, endpoint); pending.enqueue(event());
  assert.equal(await pending.flush(5), false); pending.stop(); assert.equal(pending.pending, 0);
});
test('serialization and connection failures never reject', async t => {
  const endpoint = await listen(t, (_req, res) => res.end());
  const tx = transport(t, endpoint, { maxRetries: 0 });
  assert.equal(tx.enqueue({ ...event(), message: 'x'.repeat(20000) }), false);
  const circular = event(); circular.self = circular; assert.equal(tx.enqueue(circular), false);
  const disconnected = transport(t, 'http://127.0.0.1:1/events', { maxRetries: 0 });
  disconnected.enqueue(event()); assert.equal(await disconnected.flush(), false);
});
test('background interval sends partial batches without an explicit flush', async t => {
  let received; const done = new Promise(r => { received = r; });
  const endpoint = await listen(t, async (req, res) => { await body(req); res.end(); received(); });
  const tx = transport(t, endpoint, { flushInterval: 5 }); tx.enqueue(event());
  await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('no delivery')), 1000); timer.unref(); })]);
  assert.equal(await tx.flush(), true);
});

test('real HTTP Retry-After seconds are honored and dates beyond budget stop retries', async t => {
  let calls = 0; const times = [];
  const endpoint = await listen(t, (_req, res) => {
    times.push(performance.now()); res.writeHead(++calls === 1 ? 429 : 202, calls === 1 ? { 'retry-after': '1' } : {}); res.end();
  });
  const tx = transport(t, endpoint, { maxDelay: 2000 }); tx.enqueue(event());
  assert.equal(await tx.flush(4000), true); assert.equal(calls, 2); assert.ok(times[1] - times[0] >= 950);
  let datedCalls = 0;
  const dated = await listen(t, (_req, res) => { datedCalls++; res.writeHead(503, { 'retry-after': new Date(Date.now() + 60000).toUTCString() }); res.end(); });
  const overBudget = transport(t, dated, { maxDelay: 10 }); overBudget.enqueue(event());
  assert.equal(await overBudget.flush(), false); assert.equal(datedCalls, 1);
});
