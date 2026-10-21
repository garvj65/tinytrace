import { byteLength, fingerprint } from './utils.js';
import type { RedactionOptions, TraceEvent } from './types.js';
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
export function prepareEvent(value: unknown, redact = true, rules: RedactionOptions = {}): TraceEvent | null {
  try {
    const raw = JSON.stringify(value);
    if (!raw || byteLength(raw) > 65536) return null;
    const e = JSON.parse(raw);
    if (!obj(e) || !str(e.event_id, 32) || !/^[a-f0-9]{32}$/.test(e.event_id)
      || !str(e.fingerprint, 16) || !/^[a-f0-9]{16}$/.test(e.fingerprint)
      || !['node', 'javascript'].includes(String(e.platform)) || (e.level !== 'info' && e.level !== 'error')
      || !str(e.timestamp, 64) || !Number.isFinite(Date.parse(e.timestamp))
      || !str(e.message, 2048) || !str(e.environment, 64) || !obj(e.tags)
      || Object.keys(e.tags).length > 32 || !Object.entries(e.tags).every(([k, v]) => str(k, 128) && str(v, 256))
      || !Array.isArray(e.breadcrumbs) || e.breadcrumbs.length > 20
      || !e.breadcrumbs.every(c => obj(c) && str(c.message, 512) && str(c.timestamp, 64)
        && Number.isFinite(Date.parse(c.timestamp)) && (c.category === undefined || str(c.category, 128)))
      || (e.mechanism !== undefined && (!str(e.mechanism, 20) || !['manual', 'uncaughtException', 'unhandledRejection', 'onerror'].includes(e.mechanism)))
      || (e.release !== undefined && !str(e.release, 128))) return null;
    const validTrace = (t: unknown) => obj(t) && str(t.trace_id, 32) && /^[a-f0-9]{32}$/.test(t.trace_id)
      && str(t.span_id, 16) && /^[a-f0-9]{16}$/.test(t.span_id)
      && (t.parent_span_id === undefined || (str(t.parent_span_id, 16) && /^[a-f0-9]{16}$/.test(t.parent_span_id)));
    if ((e.trace !== undefined && !validTrace(e.trace)) || (e.type !== undefined && e.type !== 'transaction')
      || (e.type === 'transaction' && !e.trace)
      || (e.spans !== undefined && (!Array.isArray(e.spans) || e.spans.length > 100 || !e.spans.every(s => validTrace(s)
        && obj(s) && str(s.name, 256) && str(s.op, 64) && ['ok', 'error'].includes(String(s.status))
        && typeof s.start_timestamp === 'number' && Number.isFinite(s.start_timestamp) && s.start_timestamp >= 0
        && typeof s.timestamp === 'number' && Number.isFinite(s.timestamp) && s.timestamp >= s.start_timestamp)))) return null;
    const ex = e.exception;
    if (ex !== undefined && (!obj(ex) || !str(ex.type, 128) || !str(ex.value, 2048)
      || !Array.isArray(ex.frames) || ex.frames.length > 32 || !ex.frames.every(f => obj(f)
        && str(f.filename, 2048) && (f.function === undefined || str(f.function, 256))
        && Number.isSafeInteger(f.lineno) && Number(f.lineno) >= 0
        && Number.isSafeInteger(f.colno) && Number(f.colno) >= 0))) return null;
    // Whitelist the schema after JSON snapshotting; unknown hook fields are never transmitted.
    const event = Object.fromEntries(['event_id', 'timestamp', 'platform', 'level', 'message',
      'environment', 'tags', 'breadcrumbs', 'fingerprint', 'mechanism', 'exception', 'release', 'trace', 'type', 'spans']
      .filter(k => e[k] !== undefined).map(k => [k, e[k]])) as unknown as TraceEvent;
    event.breadcrumbs = event.breadcrumbs.map(({ timestamp, message, category }) => ({ timestamp, message, ...(category === undefined ? {} : { category }) }));
    if (event.exception) event.exception = { type: event.exception.type, value: event.exception.value,
      frames: event.exception.frames.map(({ filename, lineno, colno, function: fn }) => ({ filename, lineno, colno, ...(fn === undefined ? {} : { function: fn }) })) };
    if (event.trace) event.trace = traceOnly(event.trace);
    if (event.spans) event.spans = event.spans.map(s => ({ ...traceOnly(s), name: s.name, op: s.op,
      start_timestamp: s.start_timestamp, timestamp: s.timestamp, status: s.status }));
    const safe = (redact ? scrub(event) : event) as TraceEvent;
    applyRules(safe, rules);
    safe.fingerprint = fingerprint([safe.type ?? (safe.exception ? 'exception' : 'message'), safe.exception?.type,
      safe.message, safe.exception?.frames.slice(0, 5).map(f => [f.filename, f.function]) ?? []]);
    if (redact || Object.keys(rules).length) return prepareEvent(safe, false);
    return safe;
  } catch { return null; }
}
function traceOnly(t: NonNullable<TraceEvent['trace']>) {
  return { trace_id: t.trace_id, span_id: t.span_id, ...(t.parent_span_id ? { parent_span_id: t.parent_span_id } : {}) };
}
function applyRules(event: TraceEvent, rules: RedactionOptions): void {
  const keys = new Set((rules.keys ?? []).slice(0, 100).map(k => k.toLowerCase()));
  const values = (rules.values ?? []).slice(0, 100).filter(v => typeof v === 'string' && v.length > 0 && v.length <= 2048).sort((a, b) => b.length - a.length);
  const paths = (rules.paths ?? []).slice(0, 100).map(p => p.split('.'));
  const walk = (value: unknown, path: string[]): unknown => {
    const key = path.at(-1) ?? '';
    if (typeof value === 'string') {
      if (keys.has(key.toLowerCase()) || paths.some(p => p.length === path.length && p.every((s, i) => s === '*' || s === path[i]))) return '[Redacted]';
      for (const secret of values) value = (value as string).split(secret).join('[Redacted]');
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)]));
    if (obj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [values.reduce((s, secret) => s.split(secret).join('[Redacted]'), k), walk(v, [...path, k])]));
    return value;
  };
  // Only content fields are configurable: IDs, timestamps and numeric positions stay valid.
  for (const key of ['message', 'environment', 'release', 'tags', 'breadcrumbs', 'exception', 'spans'] as const) {
    if (event[key] !== undefined) {
      const original = event[key];
      const sanitized = walk(original, [key]);
      // Restore structural fields after walking compound content.
      if (key === 'breadcrumbs') (sanitized as TraceEvent['breadcrumbs']).forEach((c, i) => { c.timestamp = event.breadcrumbs[i]!.timestamp; });
      if (key === 'spans') (sanitized as NonNullable<TraceEvent['spans']>).forEach((s, i) => Object.assign(s, traceOnly(event.spans![i]!), { status: event.spans![i]!.status }));
      Object.assign(event, { [key]: sanitized });
    }
  }
  if (rules.allowTags) event.tags = Object.fromEntries(Object.entries(event.tags).filter(([k]) => rules.allowTags!.includes(k)));
}
export function redactEvent(value: unknown, rules?: RedactionOptions): TraceEvent | null { return prepareEvent(value, true, rules); }

