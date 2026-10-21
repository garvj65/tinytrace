import { buildEvent, text } from './event.js';
import { prepareEvent } from './privacy.js';
import { mapFrames } from './sourcemaps.js';
import { randomHex } from './utils.js';
import type { Breadcrumb, Options, Scope, SpanData, TraceEvent } from './types.js';
import type { DeliveryQueue } from './queue.js';
interface InternalScope extends Scope { spans?: SpanData[]; captured?: Set<unknown>; failed?: boolean; sampled?: boolean }
export interface ScopeRuntime {
  current(): Scope | undefined;
  run<T>(scope: Scope, callback: () => T): T;
}
export class ScopeClient {
  protected closed = false;
  private root: InternalScope = { tags: Object.create(null), breadcrumbs: [] };
  constructor(protected options: Omit<Options, 'durable'>, readonly transport?: DeliveryQueue, private runtime?: ScopeRuntime, private fixed?: InternalScope, private guard = { capturing: false }, private platform: TraceEvent['platform'] = 'node') {}
  private scope(): InternalScope { return this.fixed ?? this.runtime?.current() ?? this.root; }
  capture(value: unknown, error: boolean, mechanism: TraceEvent['mechanism'] = 'manual', extra?: Partial<TraceEvent>): string | undefined {
    if (this.closed || this.guard.capturing || !this.transport) return;
    const rate = typeof this.options.sampleRate === 'number' && Number.isFinite(this.options.sampleRate) ? Math.max(0, Math.min(1, this.options.sampleRate)) : 1;
    if (extra?.type === 'transaction' ? this.scope().sampled === false : Math.random() >= rate) return;
    this.guard.capturing = true;
    try {
      let event: TraceEvent | null = Object.assign(buildEvent(value, error), extra);
      event.platform = this.platform;
      const scope = this.scope();
      if (error && scope.trace) scope.failed = true;
      event.environment = text(this.options.environment ?? 'development', 64);
      if (this.options.release !== undefined) event.release = text(this.options.release, 128);
      event.tags = { ...scope.tags }; event.breadcrumbs = scope.breadcrumbs.map(c => ({ ...c }));
      if (scope.trace && !event.trace) event.trace = { ...scope.trace };
      if (error) event.mechanism = mechanism;
      mapFrames(event);
      const hook = event.type === 'transaction' ? this.options.beforeSendTransaction : this.options.beforeSend;
      if (hook) event = hook(event);
      if (!event) return;
      if (typeof (event as unknown as { then?: unknown }).then === 'function') { void Promise.resolve(event).catch(() => {}); return; }
      event = prepareEvent(event, this.options.redact !== false, this.options.redaction);
      return event && this.transport.enqueue(event) ? event.event_id : undefined;
    } catch { return undefined; }
    finally { this.guard.capturing = false; }
  }
  captureException(error: unknown): string | undefined { return this.capture(error, true); }
  captureMessage(message: string): string | undefined { return this.capture(message, false); }
  async captureExceptionAsync(error: unknown): Promise<string | undefined> {
    const id = this.captureException(error); return id && await this.persist() ? id : undefined;
  }
  setTag(key: string, value: string): void {
    try {
      if (this.closed) return;
      const tags = this.scope().tags, k = text(key, 128);
      if (Object.hasOwn(tags, k) || Object.keys(tags).length < 32) tags[k] = text(value, 256);
    } catch {}
  }
  addBreadcrumb(value: string | Pick<Breadcrumb, 'message' | 'category'>): void {
    try {
      if (this.closed) return;
      const item = typeof value === 'string' ? { message: value } : value;
      const crumbs = this.scope().breadcrumbs;
      crumbs.push({ timestamp: new Date().toISOString(), message: text(item.message, 512), ...(item.category ? { category: text(item.category, 128) } : {}) });
      if (crumbs.length > 20) crumbs.shift();
    } catch {}
  }
  withScope<T>(callback: (scope: ScopeClient) => T, initial: Partial<Pick<Scope, 'tags' | 'breadcrumbs'>> = {}): T {
    const parent = this.scope();
    const scope: InternalScope = { ...parent, tags: { ...parent.tags }, breadcrumbs: parent.breadcrumbs.map(c => ({ ...c })) };
    const child = new ScopeClient(this.options, this.closed ? undefined : this.transport, this.runtime, scope, this.guard, this.platform);
    try { for (const [k, v] of Object.entries(initial.tags ?? {})) child.setTag(k, v); for (const c of initial.breadcrumbs ?? []) child.addBreadcrumb(c); } catch {}
    return this.runtime ? this.runtime.run(scope, () => callback(child)) : callback(child);
  }
  async startSpan<T>(options: { name: string; op?: string }, callback: (scope: ScopeClient) => T | Promise<T>): Promise<T> {
    return this.withScope(async child => {
      const scope = child.scope(), parent = scope.trace, root = !parent;
      const trace = { trace_id: parent?.trace_id ?? randomHex(16), span_id: randomHex(8), ...(parent ? { parent_span_id: parent.span_id } : {}) };
      scope.trace = trace; scope.failed = false; scope.spans ??= []; scope.captured ??= new Set();
      if (root) {
        const rate = this.options.tracesSampleRate;
        scope.sampled = Math.random() < (typeof rate === 'number' && Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 1);
      }
      const span: SpanData = { ...trace, name: text(options.name, 256), op: text(options.op ?? 'function', 64),
        start_timestamp: Date.now() / 1000, timestamp: Date.now() / 1000, status: 'ok' };
      const started = performance.now();
      try { return await callback(child); }
      catch (error) {
        span.status = 'error';
        if (!scope.captured.has(error)) { child.captureException(error); if (scope.captured.size < 100) scope.captured.add(error); }
        throw error;
      } finally {
        if (scope.failed) span.status = 'error';
        span.timestamp = span.start_timestamp + Math.max(0, performance.now() - started) / 1000;
        if (scope.spans.length < 99 || root) scope.spans.push(span);
        if (root) child.capture(span.name, false, 'manual', { type: 'transaction', trace, spans: scope.spans.slice(0, 100) });
      }
    });
  }
  flush(timeout?: number): Promise<boolean> { return this.transport?.flush(timeout) ?? Promise.resolve(true); }
  persist(): Promise<boolean> { return this.transport?.persist() ?? Promise.resolve(true); }
  getStats() { return this.transport?.stats() ?? { queued: 0, sent: 0, dropped: 0, persisted: 0, replayed: 0, storageErrors: 0, deferred: 0 }; }
}
