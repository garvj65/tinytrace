import { ScopeClient } from './client.js';
import { DeliveryQueue, type PostResult } from './queue.js';
import { BrowserStore } from './browser-store.js';
import { resolveTarget, type Target } from './sentry.js';
import type { BrowserOptions, Scope } from './types.js';
export type { BrowserOptions, TraceEvent, Breadcrumb, Frame, RedactionOptions, DeliveryStats, Scope, SpanData } from './types.js';
export type { BrowserOptions as Options } from './types.js';
export { ScopeClient } from './client.js';
export { redactEvent } from './privacy.js';
export { registerSourceMap, clearSourceMaps, type RawSourceMap } from './sourcemaps.js';
export { encodeEnvelope, toSentryEvent } from './sentry.js';
class BrowserTransport extends DeliveryQueue {
  constructor(target: Target, options: BrowserOptions) {
    super(target, options, options.durable ? new BrowserStore(options.durable, target.dsn ?? target.endpoint.href) : undefined, options.durable);
  }
  protected post(body: string): Promise<PostResult> {
    return new Promise(resolve => {
      const controller = new AbortController(); let settled = false;
      const done = (status = 0, retryAfter = 0) => {
        if (settled) return; settled = true;
        clearTimeout(timer); this.cancel = undefined; controller.abort(); resolve({ status, retryAfter });
      };
      const timer = setTimeout(() => done(), this.timeout); this.cancel = () => done();
      void fetch(this.target.endpoint.href, { method: 'POST', body, credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': this.target.dsn ? 'text/plain' : 'application/json' } }).then(response => {
        const raw = response.headers.get('retry-after') ?? '';
        const hint = raw ? (/^\d+$/.test(raw) ? +raw * 1000 : Date.parse(raw) - Date.now()) : 0;
        void response.body?.cancel().catch(() => {}); done(response.status, Number.isNaN(hint) ? 0 : Math.max(0, hint));
      }).catch(() => done());
    });
  }
}
class BrowserClient extends ScopeClient {
  declare readonly transport: BrowserTransport;
  constructor(options: BrowserOptions) {
    super(options, new BrowserTransport(resolveTarget(options), options), undefined, undefined, undefined, 'javascript');
    if (options.globalHandlers !== false) {
      addEventListener('error', this.onError); addEventListener('unhandledrejection', this.onRejection);
    }
    addEventListener('pagehide', this.onHide);
  }
  private onError = (event: ErrorEvent) => { this.capture(event.error ?? Error(event.message), true, 'onerror', { platform: 'javascript' }); };
  private onRejection = (event: PromiseRejectionEvent) => { this.capture(event.reason, true, 'unhandledRejection', { platform: 'javascript' }); };
  private onHide = () => { void this.flush(1000); };
  override capture(...args: Parameters<ScopeClient['capture']>) { return super.capture(args[0], args[1], args[2], { ...args[3], platform: 'javascript' }); }
  detach(): void {
    this.closed = true; removeEventListener('error', this.onError); removeEventListener('unhandledrejection', this.onRejection); removeEventListener('pagehide', this.onHide);
  }
}
let client: BrowserClient | undefined;
const disabled = new ScopeClient({});
export function init(options: BrowserOptions): void {
  try {
    resolveTarget(options);
    const previous = client; client = undefined;
    previous?.detach(); if (previous) void previous.transport.shutdown();
    client = new BrowserClient({ ...options });
  } catch {}
}
export function captureException(error: unknown): string | undefined { return client?.captureException(error); }
export function captureExceptionAsync(error: unknown): Promise<string | undefined> { return client?.captureExceptionAsync(error) ?? Promise.resolve(undefined); }
export function captureMessage(message: string): string | undefined { return client?.captureMessage(message); }
export function setTag(key: string, value: string): void { client?.setTag(key, value); }
export function addBreadcrumb(value: Parameters<ScopeClient['addBreadcrumb']>[0]): void { client?.addBreadcrumb(value); }
export function withScope<T>(callback: (scope: ScopeClient) => T, initial?: Partial<Pick<Scope, 'tags' | 'breadcrumbs'>>): T { return (client ?? disabled).withScope(callback, initial); }
export function startSpan<T>(options: { name: string; op?: string }, callback: (scope: ScopeClient) => T | Promise<T>): Promise<T> { return (client ?? disabled).startSpan(options, callback); }
export function flush(timeout?: number): Promise<boolean> { return client?.flush(timeout) ?? Promise.resolve(true); }
export function persist(): Promise<boolean> { return client?.persist() ?? Promise.resolve(true); }
export function getStats() { return (client ?? disabled).getStats(); }
export async function close(timeout = 2000): Promise<boolean> {
  const current = client; client = undefined;
  if (!current) return true;
  current.detach(); try { return await current.flush(timeout); } finally { await current.transport.shutdown(); }
}
