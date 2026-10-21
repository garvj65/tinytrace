import { fingerprint, randomHex } from './utils.js';
import type { Frame, TraceEvent } from './types.js';

export function text(value: unknown, max = 2048): string {
  try { return String(value).slice(0, max); } catch { return '[unreadable]'; }
}
export function parseStack(stack: string): Frame[] {
  return stack.slice(0, 16384).split('\n').slice(0, 33).flatMap(line => {
    const match = /^\s*at\s+(?:(.*?)\s+\()?(.+):(\d+):(\d+)\)?$/.exec(line)
      ?? /^(.*?)@(.+):(\d+):(\d+)$/.exec(line);
    return match ? [{ function: match[1]?.slice(0, 256), filename: match[2]!.slice(0, 2048), lineno: +match[3]!, colno: +match[4]! }] : [];
  }).slice(0, 32);
}
export function buildEvent(value: unknown, error: boolean): TraceEvent {
  let type = 'Error', message = text(value), frames: Frame[] = [];
  if (error) {
    try {
      if (value instanceof Error) {
        type = text(value.name, 128); message = text(value.message);
        frames = parseStack(text(value.stack, 16384));
      }
    } catch { /* A throwing getter must not escape into the application. */ }
  }
  const signature = [error ? 'exception' : 'message', type, message,
    frames.slice(0, 5).map(f => [f.filename, f.function ?? ''])];
  return {
    event_id: randomHex(16), timestamp: new Date().toISOString(),
    platform: 'node', level: error ? 'error' : 'info', message, environment: 'development',
    tags: {}, breadcrumbs: [], fingerprint: fingerprint(signature),
    ...(error ? { exception: { type, value: message, frames }, mechanism: 'manual' as const } : {})
  };
}

