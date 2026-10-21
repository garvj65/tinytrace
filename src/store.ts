export interface StoredEvent { id: string; body: string; created: number; due: number }
export interface EventStore {
  discarded?: number;
  load(): Promise<StoredEvent[]>;
  put(record: StoredEvent): Promise<void>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
export interface StoreOptions { maxEvents?: number; maxBytes?: number; maxAge?: number; retryInterval?: number }
export function validRecord(r: unknown): r is StoredEvent {
  if (!r || typeof r !== 'object') return false;
  const x = r as StoredEvent;
  return /^[a-f0-9]{32}$/.test(x.id) && typeof x.body === 'string' && x.body.length <= 65536
    && Number.isFinite(x.created) && x.created > 0 && Number.isFinite(x.due) && x.due >= 0;
}
