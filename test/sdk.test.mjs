import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../dist/index.js';
import { buildEvent, parseStack } from '../dist/event.js';
import { listen, body } from './helpers.mjs';

test('capture snapshots tags/breadcrumbs and groups repeated exceptions', async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  sdk.init({ endpoint, globalHandlers: false, environment: 'test' }); t.after(() => sdk.close(0));
  sdk.setTag('service', 'billing'); sdk.setTag('__proto__', 'safe');
  for (let i = 0; i < 25; i++) sdk.addBreadcrumb(`crumb ${i}`);
  const err = new TypeError('bad payment'), id = sdk.captureException(err);
  sdk.setTag('service', 'changed'); sdk.addBreadcrumb('later'); sdk.captureException(err); sdk.captureMessage('ready');
  assert.equal(await sdk.flush(), true);
  assert.equal(events[0].event_id, id); assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(events[0].tags.service, 'billing'); assert.equal(events[0].tags.__proto__, 'safe');
  assert.equal(events[0].breadcrumbs.length, 20); assert.equal(events[0].breadcrumbs[0].message, 'crumb 5');
  assert.equal(events[0].environment, 'test'); assert.equal(events[0].exception.type, 'TypeError');
  assert.equal(events[0].fingerprint, events[1].fingerprint); assert.equal(events[2].level, 'info');
});
test('stack parser handles V8 named/bare/Windows/async frames and skips native lines', () => {
  const frames = parseStack('Error: x\n at fn (/app/a.js:12:3)\n at C:\\app\\b.js:5:6\n at async run (file:///app/c.mjs:1:2)\n at native');
  assert.equal(frames.length, 3); assert.equal(frames[0].function, 'fn');
  assert.equal(frames[1].filename, 'C:\\app\\b.js'); assert.equal(frames[2].function, 'async run');
  assert.deepEqual(parseStack('no frames'), []);
});
test('beforeSend redacts or filters; hook failures and recursive capture stay contained', async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  t.after(() => sdk.close(0));
  sdk.init({ endpoint, globalHandlers: false, beforeSend: event => {
    assert.equal(sdk.captureMessage('recursive'), undefined);
    if (event.message === 'drop') return null;
    if (event.message === 'throw') throw Error('hook failed');
    if (event.message === 'cycle') { event.self = event; return event; }
    event.message = 'redacted'; return event;
  } });
  for (const msg of ['drop', 'throw', 'cycle']) assert.equal(sdk.captureMessage(msg), undefined);
  assert.ok(sdk.captureMessage('secret')); await sdk.flush(); assert.equal(events.length, 1);
  assert.equal(events[0].message, 'redacted');
  sdk.init({ endpoint, globalHandlers: false, beforeSend: async () => { throw Error('async misuse'); } });
  assert.equal(sdk.captureMessage('async'), undefined); await new Promise(r => setImmediate(r));
});
test('sampling endpoints and hostile values are safe', async t => {
  const endpoint = await listen(t, (_req, res) => res.end()); t.after(() => sdk.close(0));
  sdk.init({ endpoint, globalHandlers: false, sampleRate: 0 }); assert.equal(sdk.captureMessage('no'), undefined);
  sdk.init({ endpoint, globalHandlers: false, sampleRate: 0.5 });
  t.mock.method(Math, 'random', () => 0.75); assert.equal(sdk.captureMessage('no'), undefined);
  Math.random.mock.mockImplementation(() => 0.25); assert.ok(sdk.captureMessage('yes'));
  const hostile = new Proxy({}, { get() { throw Error('getter'); }, getPrototypeOf() { throw Error('prototype'); } });
  assert.doesNotThrow(() => sdk.captureException(hostile)); assert.doesNotThrow(() => sdk.addBreadcrumb(null));
  assert.equal(buildEvent(hostile, true).message, '[unreadable]'); await sdk.flush();
});
test('reinitialization removes listeners; close detaches and rejects later captures', async t => {
  const endpoint = await listen(t, (_req, res) => res.end());
  const count = process.listenerCount('uncaughtException');
  sdk.init({ endpoint }); sdk.init({ endpoint }); assert.equal(process.listenerCount('uncaughtException'), count + 1);
  sdk.captureMessage('end'); assert.equal(await sdk.close(), true);
  assert.equal(process.listenerCount('uncaughtException'), count); assert.equal(sdk.captureMessage('late'), undefined);
  assert.doesNotThrow(() => sdk.init({ endpoint: 'invalid' })); assert.equal(await sdk.close(), true);
});
