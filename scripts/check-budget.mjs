import { readdirSync, readFileSync } from 'node:fs';
const files = ['src', 'test', 'examples', 'scripts'].flatMap(dir => readdirSync(dir).filter(f => /\.(ts|mjs)$/.test(f)).map(f => dir + '/' + f));
const lines = files.reduce((n, file) => n + readFileSync(file, 'utf8').trimEnd().split('\n').length, 0);
console.log('Handwritten code lines:', lines);
if (lines >= 800) throw Error('Keep the SDK, tests, demo and scripts below 800 lines');
