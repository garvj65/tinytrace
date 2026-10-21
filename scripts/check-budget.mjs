import { readdirSync, readFileSync } from 'node:fs';
const count = dir => readdirSync(dir).filter(f => /\.(ts|mjs)$/.test(f)).reduce((n, file) => n + readFileSync(dir + '/' + file, 'utf8').trimEnd().split('\n').length, 0);
const runtime = count('src'), total = ['src', 'test', 'examples', 'scripts'].reduce((n, dir) => n + count(dir), 0);
console.log('Runtime lines:', runtime, '| Total handwritten code lines:', total);
if (runtime >= 1800 || total >= 3500) throw Error('V2 budget: runtime <1800 and all handwritten code <3500 lines');
