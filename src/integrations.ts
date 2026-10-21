import type { IncomingMessage, ServerResponse } from 'node:http';
import { captureException, withScope } from './index.js';
import type { ScopeClient } from './client.js';
type Next = (error?: unknown) => void;
const requests = new WeakMap<IncomingMessage, ScopeClient>();
export function requestHandler() {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    withScope(scope => {
      void scope.startSpan({ name: 'HTTP ' + (req.method ?? 'request'), op: 'http.server' }, current => {
        requests.set(req, current); current.setTag('http.method', req.method ?? 'UNKNOWN');
        return new Promise<void>(resolve => {
          const done = () => {
            res.off('finish', done); res.off('close', done);
            if (res.statusCode >= 500 || !res.writableFinished) current.setSpanStatus('error');
            current.setTag('http.status_code', String(res.statusCode)); resolve();
          };
          res.once('finish', done); res.once('close', done);
          next();
        });
      }).catch(() => {});
    });
  };
}
export function errorHandler() {
  return (error: unknown, req: IncomingMessage, _res: ServerResponse, next: Next): void => {
    const scope = requests.get(req);
    if (scope) scope.captureException(error); else captureException(error);
    next(error);
  };
}
export function asyncRoute(handler: (req: IncomingMessage, res: ServerResponse, next: Next) => unknown) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const fail = (error: unknown) => next(error || Error('Handler rejected'));
    try { void Promise.resolve(handler(req, res, next)).catch(fail); } catch (error) { fail(error); }
  };
}
export function httpHandler(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    requestHandler()(req, res, () => {
      asyncRoute(handler)(req, res, error => {
        if (error === undefined) return;
        errorHandler()(error, req, res, () => {
          if (res.headersSent) res.destroy();
          else { res.statusCode = 500; res.end('Internal Server Error'); }
        });
      });
    });
  };
}
