import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
const events = [], envelopes = [], cookies = [];
let offline = false;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>tinytrace browser verification</title><script type="module">window.trace=await import("/dist/browser.js");</script>'); return; }
    if (/^\/dist\/[a-z-]+\.js$/.test(req.url)) { res.setHeader('content-type', 'text/javascript'); res.end(await readFile('.' + req.url)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      cookies.push(req.headers.cookie);
      if (req.url.endsWith('/envelope/')) envelopes.push(raw); else events.push(...JSON.parse(raw).events);
      res.writeHead(offline ? 503 : 202); res.end('{}'); return;
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(500); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => !!window.trace);
  await page.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/events', redaction: { values: ['BUSINESS-4711'], keys: ['customer_id'] } });
    trace.setTag('service', 'browser'); document.cookie = 'session=must-not-be-sent';
    await Promise.all(['alpha', 'beta'].map((name, i) => trace.withScope(async scope => {
      scope.setTag('request', name); scope.addBreadcrumb(name); scope.setTag('customer_id', 'private-customer');
      await new Promise(r => setTimeout(r, 15 - i * 5)); scope.captureException(Error(name + ' BUSINESS-4711'));
    })));
    await trace.startSpan({ name: 'browser-work' }, async scoped => { await scoped.startSpan({ name: 'child' }, current => { current.captureMessage('inside child'); }); });
    if (!await trace.flush()) throw Error('Browser flush failed');
  });
  for (const name of ['alpha', 'beta']) {
    const event = events.find(e => e.message.startsWith(name)); assert.equal(event.tags.request, name); assert.equal(event.platform, 'javascript');
    assert.deepEqual(event.breadcrumbs.map(c => c.message), [name]); assert.equal(event.tags.customer_id, '[Redacted]');
  }
  assert.ok(events.some(e => e.type === 'transaction' && e.spans.length === 2));
  assert.doesNotMatch(JSON.stringify(events), /BUSINESS-4711|private-customer/); assert.ok(cookies.every(c => c === undefined));
  console.log('Browser scopes, privacy, spans and credential-free delivery: PASS');
  await page.evaluate(() => { setTimeout(() => { throw Error('automatic browser error'); }, 0); void Promise.reject(Error('automatic browser rejection')); });
  await page.waitForTimeout(30); await page.evaluate(() => trace.flush());
  assert.ok(events.some(e => e.mechanism === 'onerror' && e.message === 'automatic browser error'));
  assert.ok(events.some(e => e.mechanism === 'unhandledRejection' && e.message === 'automatic browser rejection'));
  console.log('Browser automatic error and rejection listeners: PASS');
  await page.evaluate(() => trace.close()); offline = true;
  const id = await page.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/events', globalHandlers: false, maxRetries: 0,
      durable: { database: 'tinytrace-reload-test', retryInterval: 30 }, redaction: { values: ['PERSIST-4711'] } });
    const id = await trace.captureExceptionAsync(Error('offline PERSIST-4711'));
    if (!id) throw Error('IndexedDB persistence failed'); return id;
  });
  await page.waitForFunction(() => trace.getStats().deferred > 0);
  const disk = await page.evaluate(async () => {
    const request = indexedDB.open('tinytrace-reload-test');
    return new Promise(resolve => { request.onsuccess = () => {
      const db = request.result, tx = db.transaction('events'), get = tx.objectStore('events').getAll();
      get.onsuccess = () => { resolve(JSON.stringify(get.result)); db.close(); };
    }; });
  });
  assert.doesNotMatch(disk, /PERSIST-4711/);
  await page.reload(); await page.waitForFunction(() => !!window.trace); offline = false;
  const replay = await page.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/events', globalHandlers: false, maxRetries: 0, durable: { database: 'tinytrace-reload-test', retryInterval: 30 } });
    const ok = await trace.flush(3000), stats = trace.getStats(); await trace.close(); return { ok, stats };
  });
  assert.equal(replay.ok, true); assert.equal(replay.stats.replayed, 1); assert.ok(events.filter(e => e.event_id === id).length >= 2);
  console.log('IndexedDB sanitized persistence and reload replay with stable ID: PASS');
  offline = true;
  await page.evaluate(async () => { trace.init({ endpoint: location.origin + '/events', globalHandlers: false, maxRetries: 0, durable: { database: 'tinytrace-owner-test', retryInterval: 1000 } }); trace.captureMessage('owned'); if (!await trace.persist()) throw Error('Cannot persist owned event'); });
  const other = await context.newPage(); await other.goto(origin); await other.waitForFunction(() => !!window.trace);
  const secondOwner = await other.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/events', globalHandlers: false, durable: { database: 'tinytrace-owner-test' } });
    const ok = await trace.persist(), errors = trace.getStats().storageErrors; await trace.close(1); return { ok, errors };
  });
  assert.equal(secondOwner.ok, false); assert.ok(secondOwner.errors > 0); await other.close(); await page.evaluate(() => trace.close(1));
  console.log('IndexedDB concurrent tab ownership fails closed: PASS');
  const mismatch = await page.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/different-events', globalHandlers: false, durable: { database: 'tinytrace-owner-test' } });
    const ok = await trace.persist(); await trace.close(1); return ok;
  });
  assert.equal(mismatch, false); offline = false;
  const capacity = await page.evaluate(async () => {
    trace.init({ endpoint: location.origin + '/events', globalHandlers: false, durable: { database: 'tinytrace-small-test', maxBytes: 1024 } });
    trace.captureMessage('x'.repeat(2048)); const ok = await trace.persist(), stats = trace.getStats(); await trace.close(1); return { ok, stats };
  });
  assert.equal(capacity.ok, false); assert.ok(capacity.stats.storageErrors > 0);
  console.log('IndexedDB destination isolation and byte bounds: PASS');
  await page.evaluate(async () => {
    trace.init({ dsn: location.origin.replace('http://', 'http://publickey@') + '/42', globalHandlers: false });
    await trace.withScope(scope => scope.captureException(Error('browser sentry'))); if (!await trace.close()) throw Error('Sentry envelope delivery failed');
  });
  const [header, item, payload] = envelopes.at(-1).trimEnd().split('\n');
  assert.match(JSON.parse(header).dsn, /publickey@/); assert.equal(JSON.parse(item).length, Buffer.byteLength(payload)); assert.equal(JSON.parse(payload).platform, 'javascript');
  console.log('Browser Sentry envelope contract: PASS');
  await context.close();
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
