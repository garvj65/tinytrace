import { bounded, type BrowserDurableOptions } from './types.js';
import { validRecord, type EventStore, type StoredEvent } from './store.js';
import { byteLength } from './utils.js';
export class BrowserStore implements EventStore {
  discarded = 0;
  private db?: IDBDatabase;
  private release?: () => void;
  private maxEvents: number;
  private maxBytes: number;
  private maxAge: number;
  constructor(private options: BrowserDurableOptions, private destination: string) {
    this.maxEvents = bounded(options.maxEvents, 1000, 1, 10000);
    this.maxBytes = bounded(options.maxBytes, 16777216, 1024, 67108864);
    this.maxAge = bounded(options.maxAge, 604800000, 1000, 2592000000);
  }
  private transaction<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (result: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction(name, mode, { durability: 'strict' });
        let result: T;
        tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error ?? Error('Storage transaction failed'));
        run(tx.objectStore(name), value => { result = value; });
      } catch (error) { reject(error); }
    });
  }
  async load(): Promise<StoredEvent[]> {
    await new Promise<void>((resolve, reject) => {
      if (!navigator.locks) { reject(Error('Web Locks required for durable browser delivery')); return; }
      void navigator.locks.request('tinytrace:' + this.options.database, { ifAvailable: true }, async lock => {
        if (!lock) { reject(Error('Outbox is in use in another tab')); return; }
        await new Promise<void>(release => { this.release = release; resolve(); });
      }).catch(reject);
    });
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.options.database, 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(Error('Database open timed out')); }, 5000);
      request.onupgradeneeded = () => { request.result.createObjectStore('events', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
    this.db.onversionchange = () => this.db?.close();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.destination))), b => b.toString(16).padStart(2, '0')).join('');
    await this.transaction<void>('meta', 'readwrite', store => {
      const get = store.get('destination');
      get.onsuccess = () => { if (get.result !== undefined && get.result !== hash) store.transaction.abort(); else store.put(hash, 'destination'); };
    });
    const records = await this.transaction<StoredEvent[]>('events', 'readonly', (store, set) => { store.getAll().onsuccess = e => set((e.target as IDBRequest).result); });
    const accepted: StoredEvent[] = []; let bytes = 0;
    for (const record of records) {
      const size = byteLength(JSON.stringify(record));
      if (!validRecord(record) || Date.now() - record.created > this.maxAge || record.created > Date.now() + 60000) { await this.remove(record.id); this.discarded++; continue; }
      if (accepted.length >= this.maxEvents || bytes + size > this.maxBytes) throw Error('Existing outbox exceeds configured limits');
      accepted.push(record); bytes += size;
    }
    return accepted.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }
  put(record: StoredEvent): Promise<void> {
    return this.transaction('events', 'readwrite', store => {
      const get = store.getAll();
      get.onsuccess = () => {
        const others = (get.result as StoredEvent[]).filter(r => r.id !== record.id);
        const size = others.reduce((sum, r) => sum + byteLength(JSON.stringify(r)), byteLength(JSON.stringify(record)));
        if (!validRecord(record) || others.length >= this.maxEvents || size > this.maxBytes) store.transaction.abort(); else store.put(record);
      };
    });
  }
  remove(id: string): Promise<void> { return this.transaction('events', 'readwrite', store => { store.delete(id); }); }
  async close(): Promise<void> { this.db?.close(); this.release?.(); this.release = undefined; }
}
