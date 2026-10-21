import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(), consumer = mkdtempSync(join(tmpdir(), 'tinytrace-consumer-'));
const npm = (args, cwd = root) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8' });
try {
  const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts']));
  for (const path of ['dist/index.d.ts','dist/browser.js','dist/browser.d.ts','dist-cjs/index.js','dist-cjs/package.json','dist-cjs/index.d.ts']) assert.ok(pack.files.some(f => f.path === path));
  for (const path of ['docs/demo.gif', 'SECURITY.md', 'CHANGELOG.md']) assert.ok(pack.files.some(f => f.path === path));
  assert.ok(pack.files.every(f => !/(^|\/)(test|src|node_modules|\.github)(\/|$)|\.npmrc|\.env/.test(f.path)));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', type: 'module', private: true }));
  npm(['install', resolve(root, pack.filename), '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  assert.equal(Object.keys(lock.packages).length, 2);
  writeFileSync(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
    import { createServer } from 'node:http'; import { once } from 'node:events';
    import { init, captureException, close, toSentryEvent } from '@garvj65/tinytrace';
    const events=[], server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;events.push(...JSON.parse(raw).events);res.end();});
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    init({endpoint:'http://127.0.0.1:'+server.address().port+'/events',globalHandlers:false});
    captureException(Error('password=private-value')); assert.equal(await close(),true);
    assert.equal(events.length,1); assert.equal(toSentryEvent(events[0]).sdk.version, ${JSON.stringify(pack.version)}); assert.doesNotMatch(JSON.stringify(events),/private-value/);
    await new Promise(r=>server.close(r)); console.log('Installed package HTTP/redaction smoke: PASS');`);
  process.stdout.write(execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, encoding: 'utf8' }));
  writeFileSync(join(consumer, 'consumer.ts'), "import {init,redactEvent,type Options} from '@garvj65/tinytrace'; const options:Options={endpoint:'http://localhost/events',redact:true}; init(options); redactEvent({});\n// @ts-expect-error redact is boolean\nconst bad:Options={endpoint:'http://localhost/events',redact:'yes'};\n");
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit', 'consumer.ts'], { cwd: consumer, stdio: 'inherit' });
  writeFileSync(join(consumer, 'smoke.cjs'), "const assert=require('node:assert/strict'); const cjs=require('@garvj65/tinytrace'); (async()=>{const esm=await import('@garvj65/tinytrace');assert.equal(cjs.init,esm.init);assert.equal(typeof cjs.withScope,'function');assert.equal(typeof require('@garvj65/tinytrace/integrations').requestHandler,'function');console.log('Installed CommonJS/ESM shared instance: PASS');})().catch(e=>{throw e});");
  process.stdout.write(execFileSync(process.execPath, ['smoke.cjs'], { cwd: consumer, encoding: 'utf8' }));
  writeFileSync(join(consumer, 'browser.mts'), "import {init,type Options,withScope} from '@garvj65/tinytrace/browser'; const options:Options={endpoint:'https://example.test/events',durable:{database:'test'}}; init(options); withScope(scope=>scope.captureMessage('ok'));\n");
  writeFileSync(join(consumer, 'consumer.cts'), "import tiny = require('@garvj65/tinytrace'); tiny.init({endpoint:'http://localhost/events'}); tiny.withScope(scope=>scope.setTag('module','cjs'));\n");
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit', 'browser.mts', 'consumer.cts'], { cwd: consumer, stdio: 'inherit' });
  console.log('Installed Node/browser ESM and CommonJS declarations: PASS; runtime dependencies: 0');
} finally { rmSync(consumer, { recursive: true, force: true }); }

