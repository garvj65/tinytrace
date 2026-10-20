import { writeSync } from 'node:fs';
import { buildEvent, text } from './event.js';
import { prepareEvent } from './privacy.js';
import { Transport } from './transport.js';
import { bounded, type Breadcrumb, type Options, type TraceEvent } from './types.js';
export type { Options, TraceEvent, Breadcrumb, Frame } from './types.js';
export { redactEvent } from './privacy.js';

let client: Client | undefined;
class Client {
  private tags: Record<string, string> = Object.create(null);
  private crumbs: Breadcrumb[] = [];
  private capturing = false;
  private fatal = false;
  private forwarded = false;
  private closed = false;
  private hostException = false;
  private hostRejection = false;
  private strict = new Set<unknown>();
  private rate: number;
  private shutdown: number;
  readonly transport: Transport;
  constructor(private options: Options, endpoint: URL) {
    this.rate = typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
      ? Math.max(0, Math.min(1, options.sampleRate)) : 1;
    this.shutdown = bounded(options.shutdownTimeout, 2000, 1, 60000);
    this.transport = new Transport(endpoint, options);
    if (options.globalHandlers !== false) {
      this.hostException = process.listenerCount('uncaughtException') > 0 || process.hasUncaughtExceptionCaptureCallback();
      this.hostRejection = process.listenerCount('unhandledRejection') > 0;
      process.on('newListener', this.onNewListener);
      process.on('uncaughtException', this.onException);
      process.on('unhandledRejection', this.onRejection);
    }
  }
  capture(value: unknown, error: boolean, mechanism: TraceEvent['mechanism'] = 'manual'): string | undefined {
    if (this.closed || this.capturing || Math.random() >= this.rate) return;
    this.capturing = true;
    try {
      let event: TraceEvent | null = buildEvent(value, error);
      event.environment = text(this.options.environment ?? process.env.NODE_ENV ?? 'development', 64);
      event.tags = { ...this.tags }; event.breadcrumbs = this.crumbs.map(c => ({ ...c }));
      if (error) event.mechanism = mechanism;
      if (this.options.beforeSend) event = this.options.beforeSend(event);
      if (!event) return;
      if (typeof (event as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(event).catch(() => {}); return;
      }
      event = prepareEvent(event, this.options.redact !== false);
      return event && this.transport.enqueue(event) ? event.event_id : undefined;
    } catch { return undefined; }
    finally { this.capturing = false; }
  }
  tag(key: string, value: string): void {
    const k = text(key, 128);
    if (Object.hasOwn(this.tags, k) || Object.keys(this.tags).length < 32) this.tags[k] = text(value, 256);
  }
  breadcrumb(value: string | Pick<Breadcrumb, 'message' | 'category'>): void {
    const item = typeof value === 'string' ? { message: value } : value;
    this.crumbs.push({ timestamp: new Date().toISOString(), message: text(item.message, 512),
      ...(item.category ? { category: text(item.category, 128) } : {}) });
    if (this.crumbs.length > 20) this.crumbs.shift();
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
  dispose(): void { this.detach(); this.transport.stop(); }
}
export function init(options: Options): void {
  try {
    const endpoint = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return;
    const next = { ...options };
    client?.dispose(); client = undefined; client = new Client(next, endpoint);
  } catch {}
}
export function captureException(err: unknown): string | undefined { return client?.capture(err, true); }
export function captureMessage(msg: string): string | undefined { return client?.capture(msg, false); }
export function setTag(key: string, value: string): void { try { client?.tag(key, value); } catch {} }
export function addBreadcrumb(value: string | Pick<Breadcrumb, 'message' | 'category'>): void {
  try { client?.breadcrumb(value); } catch {}
}
export function flush(timeout = 2000): Promise<boolean> { return client?.transport.flush(timeout) ?? Promise.resolve(true); }
export async function close(timeout = 2000): Promise<boolean> {
  const current = client; client = undefined;
  if (!current) return true;
  current.detach();
  try { return await current.transport.flush(timeout); } finally { current.dispose(); }
}
