import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { bounded, type Options, type TraceEvent } from './types.js';

export class Transport {
  private queue: string[] = [];
  private active: string[] = [];
  private busy = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private cancel?: () => void;
  private waiters = new Set<() => void>();
  readonly batchSize: number;
  readonly capacity: number;
  private interval: number;
  private timeout: number;
  private retries: number;
  private base: number;
  private cap: number;
  sent = 0;
  dropped = 0;
  constructor(private endpoint: URL, options: Options) {
    this.batchSize = bounded(options.batchSize, 20, 1, 50);
    this.capacity = bounded(options.maxQueue, 100, 1, 1000);
    this.interval = bounded(options.flushInterval, 1000, 1, 60000);
    this.timeout = bounded(options.requestTimeout, 2000, 1, 60000);
    this.retries = bounded(options.maxRetries, 3, 0, 10);
    this.base = bounded(options.baseDelay, 200, 1, 60000);
    this.cap = bounded(options.maxDelay, 5000, 1, 60000);
  }
  get pending(): number { return this.queue.length + this.active.length; }
  enqueue(event: TraceEvent): boolean {
    try {
      const body = JSON.stringify(event);
      if (this.stopped || this.pending >= this.capacity || !body || Buffer.byteLength(body) > 16384) {
        this.dropped++; return false;
      }
      this.queue.push(body); // Snapshot now: hooks cannot mutate queued events later.
      this.schedule(this.queue.length >= this.batchSize ? 0 : this.interval);
      return true;
    } catch { this.dropped++; return false; }
  }
  private schedule(ms: number): void {
    if (this.stopped || this.busy || !this.queue.length || (this.timer && ms !== 0)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, ms).unref();
  }
  private async drain(): Promise<void> {
    if (this.busy || this.stopped || !this.queue.length) return;
    this.busy = true; this.active = this.queue.splice(0, this.batchSize);
    try {
      let delivered = false;
      const body = `{"events":[${this.active.join(',')}]}`;
      for (let attempt = 0; attempt <= this.retries && !this.stopped; attempt++) {
        const { status, retryAfter } = await this.post(body);
        if (status >= 200 && status < 300) { delivered = true; break; }
        if (!(status === 0 || status === 408 || status === 429 || status >= 500) || attempt === this.retries) break;
        if (retryAfter > this.cap) break; // Never retry earlier than a server's requested wait.
        const backoff = Math.min(this.cap, this.base * 2 ** attempt * (0.8 + Math.random() * 0.4));
        await this.delay(Math.max(backoff, retryAfter));
      }
      if (!this.stopped) { if (delivered) this.sent += this.active.length; else this.dropped += this.active.length; }
    } catch { if (!this.stopped) this.dropped += this.active.length; }
    finally {
      this.active = []; this.busy = false;
      for (const notify of this.waiters) notify();
      this.schedule(0);
    }
  }
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.cancel = undefined; resolve(); };
      const timer = setTimeout(done, ms).unref(); this.cancel = done;
      if (this.stopped) done();
    });
  }
  private post(body: string): Promise<{ status: number; retryAfter: number }> {
    return new Promise(resolve => {
      let settled = false;
      let req: ReturnType<typeof http> | undefined;
      const done = (status = 0, retryAfter = 0) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancel = undefined;
        req?.destroy(); resolve({ status, retryAfter });
      };
      const timer = setTimeout(() => done(), this.timeout).unref();
      this.cancel = () => done();
      try {
        req = (this.endpoint.protocol === 'https:' ? https : http)(this.endpoint, {
          method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
        }, res => {
          const hint = res.headers['retry-after'];
          const raw = typeof hint === 'string' ? hint : '';
          const retryAfter = raw ? (/^\d+$/.test(raw) ? +raw * 1000 : Date.parse(raw) - Date.now()) : 0;
          res.on('error', () => done());
          res.on('end', () => done(res.statusCode, Number.isNaN(retryAfter) ? 0 : Math.max(0, retryAfter)));
          res.resume();
        });
        req.on('socket', socket => socket.unref());
        req.on('error', () => done());
        req.end(body);
      } catch { done(); }
    });
  }
  flush(timeout = 2000): Promise<boolean> {
    this.schedule(0);
    return new Promise(resolve => {
      const finish = (ok: boolean) => { clearTimeout(timer); this.waiters.delete(check); resolve(ok); };
      const check = () => { if (!this.pending) finish(this.dropped === 0); };
      const timer = setTimeout(() => finish(false), bounded(timeout, 2000, 0, 60000));
      this.waiters.add(check); check(); // A referenced deadline keeps explicit flushes alive.
    });
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer);
    this.dropped += this.pending; this.queue = []; this.active = [];
    this.cancel?.();
    for (const notify of this.waiters) notify();
  }
}
