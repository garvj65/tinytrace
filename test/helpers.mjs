import { createServer } from 'node:http';
import { once } from 'node:events';
export async function listen(t, handler) {
  const server = typeof handler === 'function' ? createServer(handler) : handler;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}/events`;
}
export async function body(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
