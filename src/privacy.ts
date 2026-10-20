import { createHash } from 'node:crypto';
import type { TraceEvent } from './types.js';
const secretKey = /password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|credential|session/i;
const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function clean(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '[Redacted]')
    .replace(/\b(?:AIza[A-Za-z0-9_-]{30,}|(?:xox[baprs]|xapp)-[A-Za-z0-9-]{15,})\b/g, '[Redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '[Redacted]')
    .replace(/\b(?:set-cookie|cookie)\s*[:=][^\r\n]*/gi, 'cookie=[Redacted]')
    .replace(/\b(?:sk-(?:proj-|svcacct-)?|gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_-]{16,}\b/g, '[Redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[Redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[Redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[Redacted]@')
    .replace(/\b(password|passwd|secret|token|api[-_]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[Redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[Redacted]')
    .replace(/(\/(?:home|Users)\/|[A-Z]:\\Users\\)[^/\\\s]+/gi, '$1[Redacted]');
}
function scrub(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) return '[Redacted]';
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (obj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), scrub(v, k)]));
  return value;
}
export function prepareEvent(value: unknown, redact = true): TraceEvent | null {
  try {
    const raw = JSON.stringify(value);
    if (!raw || Buffer.byteLength(raw) > 16384) return null;
    const e = JSON.parse(raw);
    if (!obj(e) || !str(e.event_id, 32) || !/^[a-f0-9]{32}$/.test(e.event_id)
      || !str(e.fingerprint, 16) || !/^[a-f0-9]{16}$/.test(e.fingerprint)
      || e.platform !== 'node' || (e.level !== 'info' && e.level !== 'error')
      || !str(e.timestamp, 64) || !Number.isFinite(Date.parse(e.timestamp))
      || !str(e.message, 2048) || !str(e.environment, 64) || !obj(e.tags)
      || Object.keys(e.tags).length > 32 || !Object.entries(e.tags).every(([k, v]) => str(k, 128) && str(v, 256))
      || !Array.isArray(e.breadcrumbs) || e.breadcrumbs.length > 20
      || !e.breadcrumbs.every(c => obj(c) && str(c.message, 512) && str(c.timestamp, 64)
        && Number.isFinite(Date.parse(c.timestamp)) && (c.category === undefined || str(c.category, 128)))
      || (e.mechanism !== undefined && (!str(e.mechanism, 20) || !['manual', 'uncaughtException', 'unhandledRejection'].includes(e.mechanism)))) return null;
    const ex = e.exception;
    if (ex !== undefined && (!obj(ex) || !str(ex.type, 128) || !str(ex.value, 2048)
      || !Array.isArray(ex.frames) || ex.frames.length > 32 || !ex.frames.every(f => obj(f)
        && str(f.filename, 2048) && (f.function === undefined || str(f.function, 256))
        && Number.isSafeInteger(f.lineno) && Number(f.lineno) >= 0
        && Number.isSafeInteger(f.colno) && Number(f.colno) >= 0))) return null;
    // Whitelist the schema after JSON snapshotting; unknown hook fields are never transmitted.
    const event = Object.fromEntries(['event_id', 'timestamp', 'platform', 'level', 'message',
      'environment', 'tags', 'breadcrumbs', 'fingerprint', 'mechanism', 'exception']
      .filter(k => e[k] !== undefined).map(k => [k, e[k]])) as unknown as TraceEvent;
    event.breadcrumbs = event.breadcrumbs.map(({ timestamp, message, category }) => ({ timestamp, message, ...(category === undefined ? {} : { category }) }));
    if (event.exception) event.exception = { type: event.exception.type, value: event.exception.value,
      frames: event.exception.frames.map(({ filename, lineno, colno, function: fn }) => ({ filename, lineno, colno, ...(fn === undefined ? {} : { function: fn }) })) };
    if (!redact) return event;
    const safe = scrub(event) as TraceEvent;
    safe.fingerprint = createHash('sha256').update(JSON.stringify([safe.exception ? 'exception' : 'message', safe.exception?.type,
      safe.message, safe.exception?.frames.slice(0, 5).map(f => [f.filename, f.function]) ?? []])).digest('hex').slice(0, 16);
    return safe;
  } catch { return null; }
}
export function redactEvent(value: unknown): TraceEvent | null { return prepareEvent(value); }
