import type { TraceEvent } from './types.js';
import { byteLength } from './utils.js';
export interface RawSourceMap { version: 3; sources: string[]; names?: string[]; mappings: string; sourceRoot?: string }
interface Entry { column: number; source: number; line: number; originalColumn: number; name?: number }
const maps = new Map<string, { raw: RawSourceMap; lines: Entry[][]; size: number; units: number }>();
const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(segment: string): number[] {
  const values: number[] = []; let value = 0, shift = 0;
  for (const char of segment) {
    const n = digits.indexOf(char);
    if (n < 0 || shift > 30) throw Error('Invalid VLQ');
    value += (n & 31) * 2 ** shift;
    if (n & 32) shift += 5;
    else { values.push((value & 1) ? -Math.floor(value / 2) : Math.floor(value / 2)); value = 0; shift = 0; }
  }
  if (shift) throw Error('Truncated VLQ');
  return values;
}
export function registerSourceMap(filename: string, input: RawSourceMap): boolean {
  try {
    if (filename.length > 2048 || byteLength(JSON.stringify(input)) > 1048576) return false;
    const raw = JSON.parse(JSON.stringify(input)) as RawSourceMap;
    if (raw.version !== 3 || typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)
      || !raw.sources.every(s => typeof s === 'string' && s.length <= 2048)
      || (raw.names && (!Array.isArray(raw.names) || !raw.names.every(n => typeof n === 'string' && n.length <= 256)))
      || (raw.sourceRoot !== undefined && (typeof raw.sourceRoot !== 'string' || raw.sourceRoot.length > 2048))) return false;
    if ((raw.mappings.match(/;/g)?.length ?? 0) >= 100000) return false;
    let source = 0, originalLine = 0, originalColumn = 0, name = 0, segments = 0;
    const lines = raw.mappings.split(';').map(line => {
      let column = 0; const entries: Entry[] = [];
      for (const part of line.split(',')) {
        if (!part) continue;
        if (++segments > 100000) throw Error('Map too large');
        const v = decode(part);
        if (![1, 4, 5].includes(v.length)) throw Error('Invalid segment');
        column += v[0]!;
        if (column < 0 || (entries.length && column < entries.at(-1)!.column)) throw Error('Unsorted mapping');
        if (v.length === 1) { entries.push({ column, source: -1, line: 0, originalColumn: 0 }); continue; }
        source += v[1]!; originalLine += v[2]!; originalColumn += v[3]!;
        if (raw.sources[source] === undefined || originalLine < 0 || originalColumn < 0) throw Error('Invalid origin');
        const entry: Entry = { column, source, line: originalLine, originalColumn };
        if (v.length === 5) { name += v[4]!; if (raw.names?.[name] === undefined) throw Error('Invalid name'); entry.name = name; }
        entries.push(entry);
      }
      return entries;
    });
    const size = byteLength(JSON.stringify(raw)), units = segments + lines.length;
    maps.delete(filename);
    while (maps.size && (maps.size >= 100 || [...maps.values()].reduce((sum, m) => sum + m.size, size) > 8388608
      || [...maps.values()].reduce((sum, m) => sum + m.units, units) > 200000)) maps.delete(maps.keys().next().value!);
    maps.set(filename, { raw, lines, size, units }); return true;
  } catch { return false; }
}
export function clearSourceMaps(): void { maps.clear(); }
export function mapFrames(event: TraceEvent): void {
  for (const frame of event.exception?.frames ?? []) {
    const map = maps.get(frame.filename), entries = map?.lines[frame.lineno - 1];
    if (!map || !entries) continue;
    let lo = 0, hi = entries.length - 1, match: Entry | undefined;
    while (lo <= hi) { const mid = (lo + hi) >>> 1; if (entries[mid]!.column <= frame.colno - 1) { match = entries[mid]; lo = mid + 1; } else hi = mid - 1; }
    if (!match || match.source < 0) continue;
    const source = map.raw.sources[match.source]!;
    frame.filename = (map.raw.sourceRoot && !/^(?:[a-z]+:|\/)/i.test(source)
      ? map.raw.sourceRoot.replace(/\/?$/, '/') + source : source).slice(0, 2048);
    frame.lineno = match.line + 1; frame.colno = match.originalColumn + 1;
    if (match.name !== undefined) frame.function = map.raw.names![match.name];
  }
}
