import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { listen, body } from './helpers.mjs';
const sdk = new URL('../dist/index.js', import.meta.url).href;
async function child(t, source, flags = []) {
  const proc = spawn(process.execPath, [...flags, '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; }); proc.stdout.resume();
  const started = performance.now(), watchdog = setTimeout(() => proc.kill(), 5000);
  const [code, signal] = await once(proc, 'exit'); clearTimeout(watchdog);
  assert.equal(signal, null, stderr); return { code, stderr, elapsed: performance.now() - started };
}
for (const [kind, trigger, flags] of [
  ['uncaughtException', 'setTimeout(() => { throw Error("fatal"); }, 0);', []],
  ['unhandledRejection', 'Promise.reject(Error("fatal"));', []],
  ['unhandledRejection', 'Promise.reject(Error("fatal"));', ['--unhandled-rejections=strict']]
]) test(`automatic ${kind} (${flags.join() || 'default'}) delivers once, then exits 1`, async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const { code, stderr } = await child(t, `import { init } from ${JSON.stringify(sdk)}; init({endpoint:${JSON.stringify(endpoint)}}); ${trigger}`, flags);
  assert.equal(code, 1); assert.match(stderr, /bounded delivery/); assert.equal(events.length, 1); assert.equal(events[0].mechanism, kind);
});
for (const kind of ['uncaughtException', 'unhandledRejection'])
for (const method of ['on', 'once', 'prependOnceListener'])
for (const before of [true, false]) test(`${method} ${kind} ${before ? 'before' : 'after'} init retains host ownership`, async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const handler = `process.${method}('${kind}', () => { setTimeout(async () => { await close(); process.exit(7); }, 80); });`;
  const { code } = await child(t, `import { init, close } from ${JSON.stringify(sdk)};
    ${before ? handler : ''} init({endpoint:${JSON.stringify(endpoint)}}); ${before ? '' : handler}
    ${kind === 'uncaughtException' ? "setTimeout(() => { throw Error('owned'); }, 0);" : "Promise.reject(Error('owned'));"} `);
  assert.equal(code, 7); assert.equal(events.length, 1); assert.equal(events[0].mechanism, kind);
});
test('rejection escalates to a host exception handler; strict mode never duplicates', async t => {
  for (const flags of [[], ['--unhandled-rejections=strict']]) {
    const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
    const { code } = await child(t, `import { init, close } from ${JSON.stringify(sdk)};
      process.once('uncaughtException', () => setTimeout(async () => { await close(); process.exit(7); }, 80));
      init({endpoint:${JSON.stringify(endpoint)}}); Promise.reject(Error('owned'));`, flags);
    assert.equal(code, 7); assert.equal(events.length, 1); assert.equal(events[0].mechanism, 'unhandledRejection');
  }
});
test('fatal timeout is bounded; an actual in-flight request does not pin a healthy app', async t => {
  let requests = 0; const endpoint = await listen(t, () => { requests++; });
  const fatal = await child(t, `import { init } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)}, shutdownTimeout:50}); setTimeout(() => { throw Error('fatal'); }, 0);`);
  assert.equal(fatal.code, 1); assert.ok(fatal.elapsed < 2000);
  const before = requests;
  const healthy = await child(t, `import { init, captureMessage } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)}, batchSize:1, requestTimeout:10000}); captureMessage('background');
    await new Promise(r => setTimeout(r, 250));`);
  assert.equal(healthy.code, 0); assert.ok(requests > before); assert.ok(healthy.elapsed < 3000);
});
test('fatal diagnostics never print raw errors, even when hooks drop them', async t => {
  const endpoint = await listen(t, (_req, res) => res.end());
  const result = await child(t, `import { init } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)},beforeSend:()=>null});
    setTimeout(() => { throw Error('password=' + 'private-value'); }, 0);`);
  assert.equal(result.code, 1); assert.doesNotMatch(result.stderr, /private-value|password=/);
});

test('host ownership remains delegated while a once handler performs asynchronous cleanup', async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const result = await child(t, `import { init, close } from ${JSON.stringify(sdk)};
    process.once('unhandledRejection', () => {
      setTimeout(() => Promise.reject(Error('during cleanup')), 10);
      setTimeout(async () => { await close(); process.exit(7); }, 100);
    }); init({endpoint:${JSON.stringify(endpoint)}}); Promise.reject(Error('first'));`);
  assert.equal(result.code, 7); assert.equal(events.length, 2);
});
