export interface Frame { function?: string; filename: string; lineno: number; colno: number }
export interface Breadcrumb { timestamp: string; message: string; category?: string }
export interface TraceEvent {
  event_id: string;
  timestamp: string;
  platform: 'node' | 'javascript';
  level: 'error' | 'info';
  message: string;
  environment: string;
  tags: Record<string, string>;
  breadcrumbs: Breadcrumb[];
  fingerprint: string;
  exception?: { type: string; value: string; frames: Frame[] };
  mechanism?: 'manual' | 'uncaughtException' | 'unhandledRejection' | 'onerror';
  release?: string;
  trace?: TraceContext;
  type?: 'transaction';
  spans?: SpanData[];
}
export interface TraceContext { trace_id: string; span_id: string; parent_span_id?: string }
export interface SpanData extends TraceContext {
  name: string; op: string; start_timestamp: number; timestamp: number; status: 'ok' | 'error';
}
export interface Scope { tags: Record<string, string>; breadcrumbs: Breadcrumb[]; trace?: TraceContext }
export interface RedactionOptions {
  keys?: string[];
  values?: string[];
  paths?: string[];
  allowTags?: string[];
}
export interface DurableOptions {
  directory: string;
  maxEvents?: number;
  maxBytes?: number;
  maxAge?: number;
  retryInterval?: number;
}
export interface BrowserDurableOptions extends Omit<DurableOptions, 'directory'> { database: string }
export interface DeliveryStats {
  queued: number; sent: number; dropped: number; persisted: number; replayed: number;
  storageErrors: number; deferred: number;
}
export interface Options {
  endpoint?: string;
  dsn?: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  tracesSampleRate?: number;
  beforeSend?: (event: TraceEvent) => TraceEvent | null;
  beforeSendTransaction?: (event: TraceEvent) => TraceEvent | null;
  globalHandlers?: boolean;
  redact?: boolean;
  redaction?: RedactionOptions;
  durable?: DurableOptions;
  shutdownTimeout?: number;
  batchSize?: number;
  maxQueue?: number;
  flushInterval?: number;
  requestTimeout?: number;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}
export interface BrowserOptions extends Omit<Options, 'durable'> { durable?: BrowserDurableOptions }
export function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

