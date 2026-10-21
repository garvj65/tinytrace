import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import * as sdk from '../dist/index.js';
import { parseStack } from '../dist/event.js';
import { listen, body } from './helpers.mjs';
import { requestHandler, errorHandler, httpHandler } from '../dist/integrations.js';

async function capture(t, options = {}) {
  const events = [];
  const endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  sdk.init({ endpoint, globalHandlers: false, ...options });
  t.after(() => sdk.close(10));
  return events;
}
test('ESM and CommonJS share a single SDK instance', async t => {
  const events = await capture(t);
  const cjs = createRequire(import.meta.url)('../dist-cjs/index.js');
  assert.equal(cjs.init, sdk.init); cjs.setTag('module', 'commonjs'); sdk.captureMessage('shared');
  assert.equal(await cjs.flush(), true); assert.equal(events[0].tags.module, 'commonjs');
});
test('concurrent async scopes isolate global setters and nested scope changes', async t => {
  const events = await capture(t); sdk.setTag('service', 'checkout'); sdk.addBreadcrumb('root');
  await Promise.all(['alpha', 'beta'].map((name, i) => sdk.withScope(async current => {
    sdk.setTag('request', name); sdk.addBreadcrumb(name); await delay(20 - i * 10);
    await sdk.withScope(async child => { child.setTag('nested', 'yes'); await delay(1); sdk.captureMessage(name + ' nested'); });
    current.captureMessage(name);
  })));
  sdk.captureMessage('outside'); assert.equal(await sdk.flush(), true);
  for (const name of ['alpha', 'beta']) {
    const event = events.find(e => e.message === name); assert.equal(event.tags.request, name); assert.equal(event.tags.nested, undefined);
    assert.deepEqual(event.breadcrumbs.map(c => c.message), ['root', name]);
    assert.equal(events.find(e => e.message === name + ' nested').tags.nested, 'yes');
  }
  assert.deepEqual(events.find(e => e.message === 'outside').tags, { service: 'checkout' });
  const failure = Error('caller failure'); assert.throws(() => sdk.withScope(() => { throw failure; }), e => e === failure);
});
test('application redaction handles literal values, keys, paths and tag allowlists', async t => {
  const events = await capture(t, { redact: false, redaction: { values: ['ACCT-4711'], keys: ['customer_id'], paths: ['breadcrumbs.*.message'], allowTags: ['customer_id', 'service'] } });
  sdk.setTag('customer_id', 'internal-customer'); sdk.setTag('service', 'checkout'); sdk.setTag('extra', 'excluded');
  sdk.addBreadcrumb('private business detail'); sdk.captureException(Error('Order for ACCT-4711'));
  assert.equal(await sdk.flush(), true); const event = events[0];
  assert.equal(event.tags.customer_id, '[Redacted]'); assert.equal(event.tags.extra, undefined);
  assert.equal(event.breadcrumbs[0].message, '[Redacted]');
  assert.doesNotMatch(JSON.stringify(event), /ACCT-4711|internal-customer|private business detail|excluded/);
  assert.equal(event.exception.value, event.message);
});
test('source maps resolve registered flat v3 mappings without fetching source files', async t => {
  const events = await capture(t); t.after(() => sdk.clearSourceMaps());
  assert.equal(sdk.registerSourceMap('bundle.js', { version: 3, sourceRoot: 'src', sources: ['checkout.ts'], names: ['pay'], mappings: 'AAAAA;AACEA' }), true);
  const error = Error('mapped'); error.stack = 'Error: mapped\n at minified (bundle.js:2:1)'; sdk.captureException(error);
  assert.equal(await sdk.flush(), true); assert.deepEqual(events[0].exception.frames[0], { filename: 'src/checkout.ts', function: 'pay', lineno: 2, colno: 3 });
  assert.equal(sdk.registerSourceMap('bad.js', { version: 3, sources: [], mappings: 'AAAA' }), false);
  assert.equal(sdk.registerSourceMap('bad.js', { version: 3, sources: ['x'], mappings: '!' }), false);
  assert.equal(sdk.registerSourceMap('bad.js', { version: 3, sources: ['x'], mappings: 'g' }), false);
  assert.equal(parseStack('pay@https://app.test/bundle.js:2:3')[0].function, 'pay');
});
test('nested spans correlate errors, preserve caller rejection and use independent sampling', async t => {
  const events = await capture(t); const failure = Error('span failure');
  await assert.rejects(sdk.startSpan({ name: 'checkout', op: 'http.server' }, async () => {
    await sdk.startSpan({ name: 'database', op: 'db.query' }, async () => { await delay(2); throw failure; });
  }), e => e === failure);
  assert.equal(await sdk.flush(), true); const error = events.find(e => e.exception), tx = events.find(e => e.type === 'transaction');
  assert.equal(events.filter(e => e.exception).length, 1); assert.equal(tx.spans.length, 2);
  assert.equal(tx.trace.trace_id, error.trace.trace_id); assert.equal(tx.spans[0].parent_span_id, tx.trace.span_id);
  assert.equal(tx.spans[0].span_id, error.trace.span_id); assert.ok(tx.spans.every(s => s.timestamp >= s.start_timestamp && s.status === 'error'));
  sdk.init({ endpoint: 'http://127.0.0.1:1/events', globalHandlers: false, sampleRate: 0, tracesSampleRate: 1, beforeSendTransaction: e => { assert.equal(e.type, 'transaction'); return null; } });
  await sdk.startSpan({ name: 'sampled' }, () => {}); assert.equal(sdk.getStats().queued, 0);
});
test('Express middleware isolates concurrent requests and captures errors without request secrets', async t => {
  const events = await capture(t), app = express();
  app.use(requestHandler());
  app.get('/fail/:name', async (req) => { sdk.setTag('request', req.params.name); await delay(req.params.name === 'alpha' ? 20 : 1); throw Error('route ' + req.params.name); });
  app.use(errorHandler()); app.use((_error, _req, res, _next) => res.status(500).end('handled'));
  const endpoint = await listen(t, createServer(app));
  const root = endpoint.replace('/events', '');
  const responses = await Promise.all(['alpha', 'beta'].map(name => fetch(root + '/fail/' + name + '?token=do-not-record', { headers: { authorization: 'Bearer do-not-record' } })));
  assert.ok(responses.every(r => r.status === 500)); for (const r of responses) await r.text();
  assert.equal(await sdk.flush(), true);
  for (const name of ['alpha', 'beta']) assert.equal(events.find(e => e.message === 'route ' + name).tags.request, name);
  const transactions = events.filter(e => e.type === 'transaction'); assert.equal(transactions.length, 2); assert.ok(transactions.every(e => e.spans.at(-1).status === 'error'));
  assert.doesNotMatch(JSON.stringify(events), /do-not-record|authorization|\/fail\//);
});
test('native HTTP wrapper handles rejected routes and produces a request transaction', async t => {
  const events = await capture(t), endpoint = await listen(t, createServer(httpHandler(async () => { throw Error('native failure'); })));
  const response = await fetch(endpoint); assert.equal(response.status, 500); assert.equal(await response.text(), 'Internal Server Error');
  assert.equal(await sdk.flush(), true); assert.equal(events.filter(e => e.exception).length, 1); assert.equal(events.filter(e => e.type === 'transaction').length, 1);
});
test('Sentry transport sends one UTF-8 sized event per authenticated envelope', async t => {
  const envelopes = [];
  const endpoint = await listen(t, async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; envelopes.push({ raw, url: req.url, type: req.headers['content-type'] }); res.end('{}'); });
  sdk.init({ dsn: endpoint.replace('/events', '/prefix/42').replace('http://', 'http://publickey@'), globalHandlers: false, release: '2.0.0' });
  const error = Error('unicode é password=hidden-value'); error.stack = 'Error\n at inner (one.js:1:2)\n at outer (two.js:3:4)';
  sdk.captureException(error); await sdk.startSpan({ name: 'work' }, async () => { await sdk.startSpan({ name: 'child' }, () => {}); });
  assert.equal(await sdk.close(), true); assert.equal(envelopes.length, 2);
  const parsed = envelopes.map(e => { assert.equal(e.url, '/prefix/api/42/envelope/'); assert.equal(e.type, 'application/x-sentry-envelope'); const [header, item, payload] = e.raw.trimEnd().split('\n'); const h = JSON.parse(header), i = JSON.parse(item), p = JSON.parse(payload); assert.equal(i.length, Buffer.byteLength(payload)); assert.equal(h.event_id, p.event_id); assert.match(h.dsn, /publickey@/); assert.doesNotMatch(payload, /hidden-value/); return { i, p }; });
  const exception = parsed.find(x => x.i.type === 'event').p; assert.equal(exception.exception.values[0].stacktrace.frames[0].filename, 'two.js');
  const tx = parsed.find(x => x.i.type === 'transaction').p; assert.equal(tx.spans.length, 1); assert.ok(tx.start_timestamp <= tx.timestamp); assert.equal(tx.contexts.trace.trace_id, tx.spans[0].trace_id);
});
