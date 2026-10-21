import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { DeliveryQueue, type PostResult } from './queue.js';
import { NodeStore } from './node-store.js';
import type { Options } from './types.js';
import type { Target } from './sentry.js';
export class Transport extends DeliveryQueue {
  constructor(endpoint: URL, options: Options, target: Target = { endpoint }) {
    super(target, options, options.durable ? new NodeStore(options.durable, target.dsn ?? endpoint.href) : undefined, options.durable);
  }
  protected post(body: string): Promise<PostResult> {
    return new Promise(resolve => {
      let settled = false, req: ReturnType<typeof http> | undefined;
      const done = (status = 0, retryAfter = 0) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancel = undefined; req?.destroy(); resolve({ status, retryAfter });
      };
      const timer = setTimeout(() => done(), this.timeout).unref(); this.cancel = () => done();
      try {
        req = (this.target.endpoint.protocol === 'https:' ? https : http)(this.target.endpoint, {
          method: 'POST', agent: false, headers: { 'content-type': this.target.dsn ? 'application/x-sentry-envelope' : 'application/json', 'content-length': Buffer.byteLength(body) }
        }, res => {
          const raw = typeof res.headers['retry-after'] === 'string' ? res.headers['retry-after'] : '';
          const hint = raw ? (/^\d+$/.test(raw) ? +raw * 1000 : Date.parse(raw) - Date.now()) : 0;
          res.on('error', () => done()); res.on('end', () => done(res.statusCode, Number.isNaN(hint) ? 0 : Math.max(0, hint))); res.resume();
        });
        req.on('socket', socket => socket.unref()); req.on('error', () => done()); req.end(body);
      } catch { done(); }
    });
  }
}
