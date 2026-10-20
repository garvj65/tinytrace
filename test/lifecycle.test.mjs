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
  const watchdog = setTimeout(() => proc.kill(), 4000);
  const [code, signal] = await once(proc, 'exit'); clearTimeout(watchdog);
  assert.equal(signal, null, stderr); return { code, stderr };
}
for (const [kind, trigger, flags] of [
  ['uncaughtException', 'setTimeout(() => { throw Error("fatal"); }, 0);', []],
  ['unhandledRejection', 'Promise.reject(Error("fatal"));', []],
  ['unhandledRejection', 'Promise.reject(Error("fatal"));', ['--unhandled-rejections=strict']]
]) test(`automatic ${kind} (${flags.join() || 'default'}) delivers once, then exits 1`, async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const { code, stderr } = await child(t, `import { init } from ${JSON.stringify(sdk)}; init({endpoint:${JSON.stringify(endpoint)}}); ${trigger}` , flags);
  assert.equal(code, 1); assert.match(stderr, /fatal/); assert.equal(events.length, 1); assert.equal(events[0].mechanism, kind);
});
for (const [hook, trigger, mechanism] of [
  ['uncaughtException', "setTimeout(() => { throw Error('owned'); }, 0);", 'uncaughtException'],
  ['uncaughtException', "Promise.reject(Error('owned'));", 'unhandledRejection'],
  ['unhandledRejection', "Promise.reject(Error('owned'));", 'unhandledRejection']
]) test(`existing host ${hook} handler retains shutdown ownership for ${mechanism}`, async t => {
  const events = [], endpoint = await listen(t, async (req, res) => { events.push(...(await body(req)).events); res.end(); });
  const { code } = await child(t, `import { init, close } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)}});
    process.on('${hook}', () => { setTimeout(async () => { await close(); process.exit(7); }, 30); }); ${trigger}`);
  assert.equal(code, 7); assert.equal(events.length, 1); assert.equal(events[0].mechanism, mechanism);
});
test('fatal hang exits within deadline, while background work does not pin a healthy app', async t => {
  const endpoint = await listen(t, () => {});
  const result = await child(t, `import { init } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)}, shutdownTimeout:40}); setTimeout(() => { throw Error('fatal'); }, 0);`);
  assert.equal(result.code, 1);
  const healthy = await child(t, `import { init, captureMessage } from ${JSON.stringify(sdk)};
    init({endpoint:${JSON.stringify(endpoint)}, batchSize:1}); captureMessage('background');`);
  assert.equal(healthy.code, 0);
});
