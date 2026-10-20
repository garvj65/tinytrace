import { writeSync } from 'node:fs';
import { buildEvent, text } from './event.js';
import { Transport } from './transport.js';
import { bounded, type Breadcrumb, type Options, type TraceEvent } from './types.js';
export type { Options, TraceEvent, Breadcrumb, Frame } from './types.js';

let client: Client | undefined;
class Client {
  private tags: Record<string, string> = Object.create(null);
  private crumbs: Breadcrumb[] = [];
  private capturing = false;
  private fatal = false;
  private forwarded = false;
  private closed = false;
  private rate: number;
  private shutdown: number;
  readonly transport: Transport;
  constructor(private options: Options, endpoint: URL) {
    this.rate = typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
      ? Math.max(0, Math.min(1, options.sampleRate)) : 1;
    this.shutdown = bounded(options.shutdownTimeout, 2000, 1, 60000);
    this.transport = new Transport(endpoint, options);
    if (options.globalHandlers !== false) {
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
      // Misused async hooks are dropped; absorb their rejection too.
      if (typeof (event as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(event).catch(() => {}); return;
      }
      return this.transport.enqueue(event) ? event.event_id : undefined;
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
  private onException = (err: unknown, origin: string): void => {
    const rejection = this.forwarded || origin === 'unhandledRejection'; this.forwarded = false;
    this.automatic(err, rejection ? 'unhandledRejection' : 'uncaughtException',
      process.listenerCount('uncaughtException') === 1);
  };
  private onRejection = (err: unknown): void => {
    const ownsRejection = process.listenerCount('unhandledRejection') === 1;
    if (ownsRejection && process.listenerCount('uncaughtException') > 1) {
      // Our rejection listener suppresses Node's default escalation; forward to the host's exception handler.
      queueMicrotask(() => { this.forwarded = true; throw err; }); return;
    }
    this.automatic(err, 'unhandledRejection', ownsRejection);
  };
  private automatic(err: unknown, kind: 'uncaughtException' | 'unhandledRejection', ownsExit: boolean): void {
    if (this.fatal) return;
    this.capture(err, true, kind);
    if (!ownsExit) { void this.transport.flush(this.shutdown); return; }
    this.fatal = true;
    try { writeSync(2, `${text(err)}\n`); } catch { /* stderr may already be closed. */ }
    void this.transport.flush(this.shutdown).finally(() => process.exit(1));
  }
  detach(): void {
    this.closed = true;
    process.off('uncaughtException', this.onException); process.off('unhandledRejection', this.onRejection);
  }
  dispose(): void { this.detach(); this.transport.stop(); }
}
export function init(options: Options): void {
  try {
    const endpoint = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return;
    const next = { ...options }; // Do not observe subsequent caller mutations.
    client?.dispose(); client = undefined; client = new Client(next, endpoint);
  } catch { /* Ignore invalid setup without breaking the host. */ }
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
