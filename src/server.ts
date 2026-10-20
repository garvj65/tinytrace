import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { TraceEvent } from './types.js';

export function createIngest(log: (line: string) => void = console.log) {
  const groups = new Map<string, number>();
  const seen = new Set<string>(); // Bounded deduplication: retries retain event IDs.
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    if (req.method !== 'POST' || req.url !== '/events') { req.resume(); reply(404, '{"error":"not found"}'); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { req.resume(); reply(415, '{"error":"expected JSON"}'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) { reply(413, '{"error":"body too large"}'); return; }
        chunks.push(chunk);
      }
      const events: unknown = JSON.parse(Buffer.concat(chunks).toString()).events;
      if (!Array.isArray(events) || !events.length || events.length > 50 || !events.every(e =>
        e && typeof e.event_id === 'string' && /^[a-f0-9]{32}$/.test(e.event_id)
        && typeof e.fingerprint === 'string' && /^[a-f0-9]{16}$/.test(e.fingerprint)
        && typeof e.message === 'string')) { reply(400, '{"error":"invalid events"}'); return; }
      for (const e of events as TraceEvent[]) {
        if (seen.has(e.event_id)) continue;
        if (seen.size >= 10000) seen.delete(seen.values().next().value!);
        seen.add(e.event_id);
        if (!groups.has(e.fingerprint) && groups.size >= 1000) groups.delete(groups.keys().next().value!);
        const count = (groups.get(e.fingerprint) ?? 0) + 1;
        groups.set(e.fingerprint, count);
        try { log(`[${e.fingerprint}] count=${count} ${JSON.stringify(e.message.slice(0, 160))}`); } catch {}
      }
      reply(202, '{"accepted":true}');
    } catch { if (!res.headersSent) reply(400, '{"error":"invalid JSON"}'); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, groups };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createIngest();
  server.on('error', err => { console.error(err.message); process.exitCode = 1; });
  server.listen(4318, '127.0.0.1', () => console.log('tinytrace ingest: http://127.0.0.1:4318/events'));
}
