import type { Options, TraceEvent } from './types.js';
import { byteLength } from './utils.js';
export interface Target { endpoint: URL; dsn?: string }
export function resolveTarget(options: Pick<Options, 'endpoint' | 'dsn'>): Target {
  if (options.dsn) {
    if (options.endpoint) throw Error('Choose endpoint or dsn');
    const dsn = new URL(options.dsn);
    const parts = dsn.pathname.split('/').filter(Boolean), project = parts.pop();
    if (!['http:', 'https:'].includes(dsn.protocol) || dsn.password || !/^[a-zA-Z0-9]+$/.test(dsn.username)
      || !project || !/^\d+$/.test(project) || dsn.search || dsn.hash) throw Error('Invalid public DSN');
    const endpoint = new URL(dsn.origin + '/' + (parts.length ? parts.join('/') + '/' : '') + 'api/' + project + '/envelope/');
    return { endpoint, dsn: dsn.href };
  }
  const endpoint = new URL(options.endpoint ?? '');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Invalid endpoint');
  return { endpoint };
}
export function toSentryEvent(event: TraceEvent): Record<string, unknown> {
  const ex = event.exception;
  const spans = event.spans ?? [];
  const root = spans.find(s => s.span_id === event.trace?.span_id);
  return {
    event_id: event.event_id, timestamp: Date.parse(event.timestamp) / 1000, platform: event.platform,
    level: event.level, message: event.message, environment: event.environment, release: event.release,
    tags: event.tags, fingerprint: [event.fingerprint],
    sdk: { name: 'tinytrace.javascript', version: '2.0.1' },
    breadcrumbs: { values: event.breadcrumbs.map(c => ({ ...c, timestamp: Date.parse(c.timestamp) / 1000 })) },
    ...(ex ? { exception: { values: [{ type: ex.type, value: ex.value,
      mechanism: { type: event.mechanism ?? 'manual', handled: event.mechanism === 'manual' },
      stacktrace: { frames: ex.frames.slice().reverse() } }] } } : {}),
    ...(event.trace ? { contexts: { trace: { ...event.trace, ...(root ? { op: root.op, status: root.status === 'ok' ? 'ok' : 'internal_error' } : {}) } } } : {}),
    ...(event.type === 'transaction' && root ? {
      type: 'transaction', transaction: event.message, start_timestamp: root.start_timestamp, timestamp: root.timestamp,
      spans: spans.filter(s => s.span_id !== root.span_id).map(({ name, status, ...s }) => ({ ...s, description: name, status: status === 'ok' ? 'ok' : 'internal_error' }))
    } : {})
  };
}
export function encodeEnvelope(event: TraceEvent, dsn: string): string {
  const payload = JSON.stringify(toSentryEvent(event));
  return JSON.stringify({ event_id: event.event_id, dsn, sent_at: new Date().toISOString() }) + '\n'
    + JSON.stringify({ type: event.type === 'transaction' ? 'transaction' : 'event', length: byteLength(payload) }) + '\n' + payload + '\n';
}
