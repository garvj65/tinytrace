import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bounded, type DurableOptions } from './types.js';
import { validRecord, type EventStore, type StoredEvent } from './store.js';

export class NodeStore implements EventStore {
  discarded = 0;
  private directory: string;
  private owner: string;
  private claimed = false;
  private destination: string;
  private sizes = new Map<string, number>();
  private maxEvents: number;
  private maxBytes: number;
  private maxAge: number;
  constructor(options: DurableOptions, destination: string) {
    this.directory = resolve(options.directory);
    this.owner = join(this.directory, `${process.pid}-${randomUUID()}.owner`);
    this.destination = createHash('sha256').update(destination).digest('hex');
    this.maxEvents = bounded(options.maxEvents, 1000, 1, 10000);
    this.maxBytes = bounded(options.maxBytes, 16777216, 1024, 67108864);
    this.maxAge = bounded(options.maxAge, 604800000, 1000, 2592000000);
  }
  private async read(path: string): Promise<string> {
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 140000) throw Error('Invalid outbox file');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }
  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await fs.open(this.directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async load(): Promise<StoredEvent[]> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe outbox directory');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Outbox directory must be private (0700)');
    const marker = await fs.open(this.owner, 'wx', 0o600);
    await marker.close(); this.claimed = true;
    // Unique markers avoid stale-lock unlink races. Concurrent contenders fail closed.
    for (const file of await fs.readdir(this.directory)) {
      const match = /^(\d+)-[a-f0-9-]+\.owner$/.exec(file);
      if (!match || join(this.directory, file) === this.owner) continue;
      let alive = true;
      try { process.kill(Number(match[1]), 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) throw Error('Outbox already has a live owner');
      await fs.unlink(join(this.directory, file)).catch(() => {});
    }
    const meta = join(this.directory, 'destination');
    try { await fs.writeFile(meta, this.destination, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await this.read(meta)) !== this.destination) throw Error('Outbox belongs to another destination');
    const records: StoredEvent[] = []; let bytes = 0;
    for (const file of (await fs.readdir(this.directory)).sort()) {
      if (/^[a-f0-9]{32}\.[a-f0-9-]+\.tmp$/.test(file)) { await fs.unlink(join(this.directory, file)).catch(() => {}); continue; }
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const path = join(this.directory, file);
      try {
        const raw = await this.read(path), record: unknown = JSON.parse(raw);
        if (!validRecord(record) || record.id + '.json' !== file || Date.now() - record.created > this.maxAge || record.created > Date.now() + 60000) {
          await fs.unlink(path); this.discarded++; continue;
        }
        if (records.length >= this.maxEvents || bytes + Buffer.byteLength(raw) > this.maxBytes) throw Object.assign(Error('Existing outbox exceeds configured limits'), { code: 'OUTBOX_LIMIT' });
        bytes += Buffer.byteLength(raw); this.sizes.set(record.id, Buffer.byteLength(raw)); records.push(record);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && !['ELOOP', 'ENOENT'].includes(code)) throw error;
        await fs.unlink(path).catch(() => {}); this.discarded++;
      }
    }
    await this.syncDirectory();
    return records.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }
  async put(record: StoredEvent): Promise<void> {
    const raw = JSON.stringify(record), size = Buffer.byteLength(raw), old = this.sizes.get(record.id) ?? 0;
    if (!validRecord(record) || (!old && this.sizes.size >= this.maxEvents)
      || [...this.sizes.values()].reduce((a, b) => a + b, 0) - old + size > this.maxBytes) throw Error('Outbox capacity exceeded');
    const temp = join(this.directory, record.id + '.' + randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, join(this.directory, record.id + '.json'));
      await this.syncDirectory(); this.sizes.set(record.id, size);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async remove(id: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid event ID');
    await fs.unlink(join(this.directory, id + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.sizes.delete(id); await this.syncDirectory();
  }
  async close(): Promise<void> {
    if (this.claimed) { await fs.unlink(this.owner).catch(() => {}); this.claimed = false; }
  }
}
