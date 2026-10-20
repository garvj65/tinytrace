import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../dist/index.js';
import { buildEvent } from '../dist/event.js';
import { listen, body } from './helpers.mjs';
test('redaction covers duplicated errors, context, credentials, emails, URLs and paths', () => {
  const token = ['sk', 'proj', 'q'.repeat(24)].join('-');
  const event = buildEvent(Error('password=hidden-value user@example.com'), true);
  event.tags = { authorization: 'anything', api_key: token, note: 'Bearer ' + token };
  event.breadcrumbs = [{ timestamp: event.timestamp, message: 'https://user:pass@example.org/path?token=hidden-value' }];
  event.exception.frames = [{ filename: '/home/private-user/app.ts', function: 'cookie: session=hidden-value', lineno: 1, colno: 2 }];
  const safe = sdk.redactEvent(event), wire = JSON.stringify(safe);
  assert.ok(safe); assert.doesNotMatch(wire, /hidden-value|user@example|private-user|user:pass|session=|q{24}/);
  assert.equal(safe.tags.authorization, '[Redacted]'); assert.equal(safe.tags.api_key, '[Redacted]');
  assert.match(safe.exception.value, /Redacted/); assert.notEqual(safe.fingerprint, event.fingerprint);
  assert.match(event.message, /hidden-value/); assert.equal(sdk.redactEvent({}), null);
});
test('malformed hook output cannot poison a valid batch; snapshots remove unknown fields', async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const bad = ['id', 'level', 'tags', 'frames', 'timestamp'];
  sdk.init({ endpoint, globalHandlers: false, beforeSend: e => {
    if (e.message === 'id') e.event_id = 'invalid';
    if (e.message === 'level') e.level = ['info'];
    if (e.message === 'tags') e.tags = [];
    if (e.message === 'frames') e.exception = { type: 'Error', value: 'x', frames: [{}] };
    if (e.message === 'timestamp') e.timestamp = 'invalid';
    e.extra = 'unknown-field'; return e;
  } }); t.after(() => sdk.close(0));
  for (const message of bad) assert.equal(sdk.captureMessage(message), undefined);
  assert.ok(sdk.captureMessage('valid')); assert.equal(await sdk.flush(), true);
  assert.equal(events.length, 1); assert.equal(events[0].extra, undefined);
});
test('default redaction runs after hooks; opting out is explicit; queued data is immutable', async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  let retained; t.after(() => sdk.close(0));
  const options = { endpoint, globalHandlers: false, beforeSend: e => { retained = e; e.tags.password = 'hook-value'; return e; } };
  sdk.init(options); sdk.captureException(Error('password=private-value')); retained.message = 'later mutation';
  assert.equal(await sdk.close(), true); assert.equal(events[0].tags.password, '[Redacted]');
  assert.doesNotMatch(JSON.stringify(events[0]), /private-value|hook-value|later mutation/);
  sdk.init({ ...options, redact: false }); sdk.captureException(Error('password=private-value'));
  assert.equal(await sdk.close(), true); assert.match(JSON.stringify(events[1]), /private-value|hook-value/);
});
test('repeated lifecycle operations restore all SDK-owned listener counts', async t => {
  const endpoint = await listen(t, (_req, res) => res.end());
  const names = ['newListener', 'uncaughtException', 'unhandledRejection'];
  const baseline = names.map(n => process.listenerCount(n));
  for (let i = 0; i < 25; i++) { sdk.init({ endpoint }); sdk.init({ endpoint }); assert.equal(await sdk.close(), true); }
  assert.deepEqual(names.map(n => process.listenerCount(n)), baseline);
});
