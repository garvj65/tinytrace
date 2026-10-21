import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { name, version } = JSON.parse(readFileSync('package.json'));
assert.equal(name, '@garvj65/tinytrace');
const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(version);
let published;
for (let attempt = 0; attempt < 24; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.ok) { published = await response.json(); break; }
    if (response.status !== 404 && response.status !== 429 && response.status < 500) throw Error('Registry lookup failed: ' + response.status);
    console.log('Waiting for npm registry availability:', response.status);
  } catch (error) { if (attempt === 23) throw error; }
  if (attempt < 23) await new Promise(resolve => setTimeout(resolve, 10000));
}
assert.ok(published, 'Published version did not become available within the verification window');
const [local] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
assert.equal(published.name, name); assert.equal(published.version, version);
assert.equal(published.dist.integrity, local.integrity, 'Registry tarball differs from the verified local package');
console.log('Registry version and tarball integrity verified:', name, version);
