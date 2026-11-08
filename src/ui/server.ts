import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchFn } from '../http.ts';
import {
  BadRequestError,
  getBalance,
  getBench,
  getBenchReport,
  getRun,
  listBenches,
  listRuns,
  NotFoundError,
  type ApiOptions,
  type BalanceCache,
} from './api.ts';

// `twopass ui`: a static app (dist/ui) plus a read-only JSON API over the runs folder.
// Only routing, headers and static files live here; the logic is in api.ts.
// Bound to 127.0.0.1, and every request must name 127.0.0.1:<port> or localhost:<port> as its
// Host (DNS rebinding). The OpenRouter key stays in this process: it is used for one outgoing
// request (GET /credits) and is never written to a response or a log.

export interface UiServerOptions extends ApiOptions {
  runsRoot: string;
  /** Default 4777; 0 picks a free port. */
  port?: number;
  /** How many ports after `port` to try when it is busy. Default 10. */
  portAttempts?: number;
  /** Built app. Default: <package root>/dist/ui. */
  distDir?: string;
  apiKey?: string;
  fetch?: FetchFn;
}

export interface UiServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** The package root (the folder with package.json), from src/ui/ or dist/src/ui/. */
export function packageRoot(from = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot find the twopass package root');
    dir = parent;
  }
}

export const defaultDistDir = (): string => join(packageRoot(), 'dist', 'ui');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createUiHandler(o: UiServerOptions & { getPort: () => number }) {
  const distDir = resolve(o.distDir ?? defaultDistDir());
  const balanceCache: { current?: BalanceCache } = {};
  const api: ApiOptions = {
    ...(o.now ? { now: o.now } : {}),
    ...(o.pidAlive ? { pidAlive: o.pidAlive } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}),
  };

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  async function routeApi(path: string, res: ServerResponse): Promise<void> {
    const parts = path.split('/').slice(2).map((p) => decodeURIComponent(p)); // ['runs', id?, ...]
    const [kind, id, sub, ...rest] = parts;
    if (rest.length) throw new NotFoundError('Not found');
    if (kind === 'runs' && id === undefined) return json(res, 200, await listRuns(o.runsRoot, api));
    if (kind === 'runs' && id !== undefined && sub === undefined) return json(res, 200, await getRun(o.runsRoot, id, api));
    if (kind === 'benches' && id === undefined) return json(res, 200, await listBenches(o.runsRoot, api));
    if (kind === 'benches' && id !== undefined && sub === undefined) return json(res, 200, await getBench(o.runsRoot, id, api));
    if (kind === 'benches' && id !== undefined && sub === 'report') return json(res, 200, getBenchReport(o.runsRoot, id));
    if (kind === 'balance' && id === undefined) {
      return json(
        res,
        200,
        await getBalance(o.runsRoot, {
          ...api,
          ...(o.apiKey ? { apiKey: o.apiKey } : {}),
          ...(o.fetch ? { fetch: o.fetch } : {}),
          cache: balanceCache,
        }),
      );
    }
    throw new NotFoundError('Not found');
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const index = join(distDir, 'index.html');
    if (!existsSync(index)) {
      return send(res, 503, 'The UI is not built. Run: pnpm build\n', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    // Hash routing: every page is "/", so anything that is not a file gets index.html.
    let file = index;
    if (path !== '/' && path !== '/index.html') {
      const candidate = resolve(distDir, '.' + decodeURIComponent(path));
      if (!candidate.startsWith(distDir + sep)) return send(res, 400, 'Bad path\n', 'text/plain; charset=utf-8');
      if (existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
      else if (extname(path)) return send(res, 404, 'Not found\n', 'text/plain; charset=utf-8');
    }
    const hashed = file.includes(`${sep}assets${sep}`);
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream', {
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const port = o.getPort();
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return send(res, 403, 'Forbidden: unexpected Host header\n', 'text/plain; charset=utf-8');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = url.pathname;
      if (path.includes('\0')) return send(res, 400, 'Bad path\n', 'text/plain; charset=utf-8');
      if (path === '/api' || path.startsWith('/api/')) return await routeApi(path, res);
      return serveStatic(path, res);
    } catch (err) {
      if (err instanceof BadRequestError) return json(res, 400, { error: err.message });
      if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
      if (err instanceof URIError) return json(res, 400, { error: 'Bad URL encoding' });
      // Messages from our own code (file errors, parse errors) carry no secrets, but scrub anyway.
      let message = err instanceof Error ? err.message : String(err);
      if (o.apiKey) message = message.split(o.apiKey).join('[key]');
      return json(res, 500, { error: message });
    }
  };
}

/** Starts the server on 127.0.0.1, trying the next ports when one is busy. */
export async function startUiServer(o: UiServerOptions): Promise<UiServer> {
  let port = 0;
  const handler = createUiHandler({ ...o, getPort: () => port });
  const server = createServer((req, res) => void handler(req, res));
  const first = o.port ?? 4777;
  const attempts = first === 0 ? 1 : (o.portAttempts ?? 10) + 1;

  for (let i = 0; i < attempts; i++) {
    const tryPort = first === 0 ? 0 : first + i;
    try {
      await new Promise<void>((ok, fail) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          fail(err);
        };
        const onListening = () => {
          server.off('error', onError);
          ok();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(tryPort, '127.0.0.1');
      });
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : tryPort;
      return {
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((ok) => {
            server.closeAllConnections();
            server.close(() => ok());
          }),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i === attempts - 1) throw err;
    }
  }
  throw new Error('unreachable');
}

export function uiIsBuilt(distDir = defaultDistDir()): boolean {
  return existsSync(join(distDir, 'index.html'));
}
