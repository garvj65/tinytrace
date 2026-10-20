export interface Frame { function?: string; filename: string; lineno: number; colno: number }
export interface Breadcrumb { timestamp: string; message: string; category?: string }
export interface TraceEvent {
  event_id: string;
  timestamp: string;
  platform: 'node';
  level: 'error' | 'info';
  message: string;
  environment: string;
  tags: Record<string, string>;
  breadcrumbs: Breadcrumb[];
  fingerprint: string;
  exception?: { type: string; value: string; frames: Frame[] };
  mechanism?: 'manual' | 'uncaughtException' | 'unhandledRejection';
}
export interface Options {
  endpoint: string;
  environment?: string;
  sampleRate?: number;
  beforeSend?: (event: TraceEvent) => TraceEvent | null;
  globalHandlers?: boolean;
  redact?: boolean;
  shutdownTimeout?: number;
  batchSize?: number;
  maxQueue?: number;
  flushInterval?: number;
  requestTimeout?: number;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}
export function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
