import { bounded, type DeliveryStats, type Options, type TraceEvent } from './types.js';
import { byteLength, unref } from './utils.js';
import { prepareEvent } from './privacy.js';
import { encodeEnvelope, type Target } from './sentry.js';
import type { EventStore, StoredEvent, StoreOptions } from './store.js';
export interface PostResult { status: number; retryAfter: number }
export abstract class DeliveryQueue {
  private queue: StoredEvent[] = [];
  private active: StoredEvent[] = [];
  private busy = false;
  protected stopped = false;
  private loading = false;
  private storageFailed = false;
  private staging = 0;
  private timer?: ReturnType<typeof setTimeout>;
  protected cancel?: () => void;
  private waiters = new Set<() => void>();
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private draining?: Promise<void>;
  readonly batchSize: number;
  readonly capacity: number;
  protected timeout: number;
  private interval: number;
  private retries: number;
  private base: number;
  private cap: number;
  private retryInterval: number;
  private maxAge: number;
  sent = 0; dropped = 0; persisted = 0; replayed = 0; storageErrors = 0; deferred = 0;
  constructor(protected target: Target, options: Omit<Options, 'durable'>, private store?: EventStore, storage: StoreOptions = {}) {
    this.batchSize = target.dsn ? 1 : bounded(options.batchSize, 20, 1, 50);
    this.capacity = store ? bounded(storage.maxEvents, 1000, 1, 10000) : bounded(options.maxQueue, 100, 1, 1000);
    this.interval = bounded(options.flushInterval, 1000, 1, 60000);
    this.timeout = bounded(options.requestTimeout, 2000, 1, 60000);
    this.retries = bounded(options.maxRetries, 3, 0, 10);
    this.base = bounded(options.baseDelay, 200, 1, 60000); this.cap = bounded(options.maxDelay, 5000, 1, 60000);
    this.retryInterval = bounded(storage.retryInterval, 30000, 10, 3600000);
    this.maxAge = bounded(storage.maxAge, 604800000, 1000, 2592000000);
    this.loading = !!store;
    this.ready = store ? store.load().then(async records => {
      this.dropped += store.discarded ?? 0;
      for (const record of records) {
        let event: TraceEvent | null = null;
        try { event = prepareEvent(JSON.parse(record.body), options.redact !== false, options.redaction); } catch {}
        if (!event) { await store.remove(record.id); this.dropped++; continue; }
        const sanitized = JSON.stringify(event);
        if (sanitized !== record.body) { record.body = sanitized; await store.put(record); }
        if (!this.stopped) this.queue.push(record);
        this.replayed++;
      }
    }).catch(async () => { this.storageFailed = true; this.storageErrors++; await store.close().catch(() => {}); })
      .finally(() => { this.loading = false; this.notify(); this.schedule(0); }) : Promise.resolve();
  }
  get pending(): number { return this.queue.length + this.active.length + this.staging; }
  stats(): DeliveryStats { return { queued: this.pending, sent: this.sent, dropped: this.dropped, persisted: this.persisted,
    replayed: this.replayed, storageErrors: this.storageErrors, deferred: this.deferred }; }
  enqueue(event: TraceEvent): boolean {
    try {
      const safe = prepareEvent(event, false);
      const body = safe ? JSON.stringify(safe) : '';
      if (this.stopped || this.storageFailed || this.pending >= this.capacity || !body || byteLength(body) > 65536) { this.dropped++; return false; }
      const record: StoredEvent = { id: event.event_id, body, created: Date.now(), due: 0 };
      if (this.store) {
        this.staging++;
        this.writes = this.writes.then(async () => {
          await this.ready;
          try {
            if (this.storageFailed) throw Error('Storage unavailable');
            await this.store!.put(record); this.persisted++;
            if (!this.stopped) this.queue.push(record);
          } catch { this.dropped++; this.storageErrors++; }
          finally { this.staging--; this.notify(); this.schedule(0); }
        });
      } else { this.queue.push(record); this.schedule(this.queue.length >= this.batchSize ? 0 : this.interval); }
      return true;
    } catch { this.dropped++; return false; }
  }
  async persist(): Promise<boolean> { await this.ready; await this.writes; return !this.storageFailed && this.storageErrors === 0; }
  private notify(): void { for (const fn of this.waiters) fn(); }
  private schedule(ms: number): void {
    if (this.stopped || this.storageFailed || this.loading || this.busy || !this.queue.length || (this.timer && ms !== 0)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.draining = this.drain(); }, ms); unref(this.timer);
  }
  private async drain(): Promise<void> {
    if (this.busy || this.stopped || this.storageFailed) return;
    const now = Date.now();
    const batch: StoredEvent[] = []; let bytes = 0;
    for (const e of this.queue) {
      if ((e.due > now && (!this.store || e.created + this.maxAge > now)) || batch.length >= this.batchSize) continue;
      const size = byteLength(e.body) + 1;
      if (bytes + size > 1000000) break;
      batch.push(e); bytes += size;
    }
    if (!batch.length) { this.schedule(Math.min(60000, Math.max(1, Math.min(...this.queue.map(e => this.store ? Math.min(e.due, e.created + this.maxAge) : e.due)) - now))); return; }
    const ids = new Set(batch.map(e => e.id)); this.queue = this.queue.filter(e => !ids.has(e.id));
    this.busy = true; this.active = batch;
    let status = 0, hint = 0, delivered = false;
    try {
      if (this.store) for (let i = batch.length - 1; i >= 0; i--) {
        if (batch[i]!.created + this.maxAge <= now) { await this.store.remove(batch[i]!.id); batch.splice(i, 1); this.dropped++; }
      }
      if (!batch.length) return;
      const body = this.target.dsn ? encodeEnvelope(JSON.parse(batch[0]!.body), this.target.dsn) : `{"events":[${batch.map(e => e.body).join(',')}]}`;
      for (let attempt = 0; attempt <= this.retries && !this.stopped; attempt++) {
        const result = await this.post(body); status = result.status; hint = result.retryAfter;
        if (status >= 200 && status < 300) { delivered = true; break; }
        if (!(status === 0 || status === 408 || status === 429 || status >= 500) || attempt === this.retries || hint > this.cap) break;
        if (this.store && hint > 0) for (const e of batch) await this.store.put({ ...e, due: Date.now() + hint });
        await this.delay(Math.max(Math.min(this.cap, this.base * 2 ** attempt * (0.8 + Math.random() * 0.4)), hint));
      }
      if (this.stopped) return;
      const transient = status === 0 || status === 408 || status === 429 || status >= 500;
      if (this.store && !delivered && transient) {
        for (const e of batch) {
          if (Date.now() - e.created > this.maxAge) { await this.store.remove(e.id); this.dropped++; continue; }
          e.due = Number.isFinite(hint) ? Date.now() + Math.max(hint, this.retryInterval) : Number.MAX_SAFE_INTEGER;
          await this.store.put(e); this.queue.push(e); this.deferred++;
        }
      } else {
        if (this.store) for (const e of batch) await this.store.remove(e.id);
        if (delivered) this.sent += batch.length; else this.dropped += batch.length;
      }
    } catch {
      if (this.store) { this.storageErrors++; this.storageFailed = true; }
      else if (!this.stopped) this.dropped += batch.length;
    } finally { this.active = []; this.busy = false; this.notify(); this.schedule(0); }
  }
  protected abstract post(body: string): Promise<PostResult>;
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.cancel = undefined; resolve(); };
      const timer = setTimeout(done, ms); unref(timer); this.cancel = done; if (this.stopped) done();
    });
  }
  flush(timeout = 2000): Promise<boolean> {
    this.schedule(0);
    return new Promise(resolve => {
      const finish = (ok: boolean) => { clearTimeout(timer); this.waiters.delete(check); resolve(ok); };
      const check = () => { if (!this.loading && !this.pending) finish(this.dropped === 0 && !this.storageFailed && this.storageErrors === 0); };
      const timer = setTimeout(() => finish(false), bounded(timeout, 2000, 0, 60000));
      this.waiters.add(check); check();
    });
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer);
    if (!this.store) this.dropped += this.pending;
    this.queue = []; this.active = []; this.cancel?.(); this.notify();
  }
  async shutdown(): Promise<void> {
    this.stop(); await this.ready; await this.writes; await this.draining;
    await this.store?.close().catch(() => { this.storageErrors++; });
  }
}
