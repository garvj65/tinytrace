import { writeSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ScopeClient } from './client.js';
import { resolveTarget } from './sentry.js';
import { Transport } from './transport.js';
import { bounded, type Options, type Scope } from './types.js';
export type { Options, TraceEvent, Breadcrumb, Frame, RedactionOptions, DurableOptions, DeliveryStats, Scope, SpanData, TraceContext } from './types.js';
export { ScopeClient } from './client.js';
export { redactEvent } from './privacy.js';
export { registerSourceMap, clearSourceMaps, type RawSourceMap } from './sourcemaps.js';
export { encodeEnvelope, toSentryEvent } from './sentry.js';

let client: Client | undefined;
const disabled = new ScopeClient({});
class Client extends ScopeClient {
  declare readonly transport: Transport;
  private fatal = false;
  private forwarded = false;
  private hostException = false;
  private hostRejection = false;
  private strict = new Set<unknown>();
  private shutdown: number;
  constructor(options: Options) {
    const target = resolveTarget(options), storage = new AsyncLocalStorage<Scope>();
    const transport = new Transport(target.endpoint, options, target);
    super(options, transport, { current: () => storage.getStore(), run: (scope, fn) => storage.run(scope, fn) });
    this.shutdown = bounded(options.shutdownTimeout, 2000, 1, 60000);
    if (options.globalHandlers !== false) {
      this.hostException = process.listenerCount('uncaughtException') > 0 || process.hasUncaughtExceptionCaptureCallback();
      this.hostRejection = process.listenerCount('unhandledRejection') > 0;
      process.on('newListener', this.onNewListener);
      process.on('uncaughtException', this.onException);
      process.on('unhandledRejection', this.onRejection);
    }
  }
  private onNewListener = (name: string | symbol, listener: unknown): void => {
    // Ownership stays with the host until reinit, even after a once listener removes itself.
    if (name === 'uncaughtException' && listener !== this.onException) this.hostException = true;
    if (name === 'unhandledRejection' && listener !== this.onRejection) this.hostRejection = true;
  };
  private onException = (err: unknown, origin: string): void => {
    const rejection = this.forwarded || origin === 'unhandledRejection'; this.forwarded = false;
    if (origin === 'unhandledRejection') {
      this.strict.add(err); queueMicrotask(() => this.strict.delete(err));
    }
    this.automatic(err, rejection ? 'unhandledRejection' : 'uncaughtException', !this.hostException);
  };
  private onRejection = (err: unknown): void => {
    if (this.strict.has(err)) return;
    if (!this.hostRejection && this.hostException && process.listenerCount('uncaughtException') > 1) {
      queueMicrotask(() => { this.forwarded = true; throw err; }); return;
    }
    this.automatic(err, 'unhandledRejection', !this.hostRejection && !this.hostException);
  };
  private automatic(err: unknown, kind: 'uncaughtException' | 'unhandledRejection', ownsExit: boolean): void {
    if (this.fatal || this.closed) return;
    this.capture(err, true, kind);
    if (!ownsExit) { void this.transport.flush(this.shutdown); return; }
    this.fatal = true;
    try { writeSync(2, 'tinytrace: fatal error; attempting bounded delivery\n'); } catch {}
    void this.transport.flush(this.shutdown).finally(() => process.exit(1));
  }
  detach(): void {
    this.closed = true;
    process.off('newListener', this.onNewListener);
    process.off('uncaughtException', this.onException); process.off('unhandledRejection', this.onRejection);
  }
  dispose(): void { this.detach(); void this.transport.shutdown(); }
}
export function init(options: Options): void {
  try {
    resolveTarget(options);
    client?.dispose(); client = undefined;
    client = new Client({ ...options, environment: options.environment ?? process.env.NODE_ENV ?? 'development' });
  } catch {}
}
export function captureException(err: unknown): string | undefined { return client?.captureException(err); }
export function captureExceptionAsync(err: unknown): Promise<string | undefined> { return client?.captureExceptionAsync(err) ?? Promise.resolve(undefined); }
export function captureMessage(msg: string): string | undefined { return client?.captureMessage(msg); }
export function setTag(key: string, value: string): void { client?.setTag(key, value); }
export function addBreadcrumb(value: Parameters<ScopeClient['addBreadcrumb']>[0]): void { client?.addBreadcrumb(value); }
export function withScope<T>(callback: (scope: ScopeClient) => T, initial?: Partial<Pick<Scope, 'tags' | 'breadcrumbs'>>): T {
  return (client ?? disabled).withScope(callback, initial);
}
export function startSpan<T>(options: { name: string; op?: string }, callback: (scope: ScopeClient) => T | Promise<T>): Promise<T> {
  return (client ?? disabled).startSpan(options, callback);
}
export function flush(timeout = 2000): Promise<boolean> { return client?.flush(timeout) ?? Promise.resolve(true); }
export function persist(): Promise<boolean> { return client?.persist() ?? Promise.resolve(true); }
export function getStats() { return (client ?? disabled).getStats(); }
export async function close(timeout = 2000): Promise<boolean> {
  const current = client; client = undefined;
  if (!current) return true;
  current.detach();
  try { return await current.transport.flush(timeout); } finally { await current.transport.shutdown(); }
}
