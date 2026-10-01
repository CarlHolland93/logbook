// The example's one process: serves the app, stores records, delivers
// check-ins, and proxies model calls so no API key reaches the browser.
//
//   pnpm example            real clock, writes records.jsonl
//   pnpm example --demo     shiftable clock, writes records.demo.jsonl
//
// Environment: LOGBOOK_MODEL (default qwen2.5:7b), LOGBOOK_MODEL_URL (default
// http://127.0.0.1:11434), LOGBOOK_API_KEY, LOGBOOK_PORT (default 5178).
import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../scripts/cli';
import type { Hypothesis } from '../../src/types';
import type { LogRecord } from '../../src/types';
import { RecordStore } from '../shared/record-store';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1_000_000;
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// Vite's own deny list (8.3), which setting fs.deny replaces rather than extends.
const VITE_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];
// Every path api() answers. A route missing from here is never reached.
const API_PATH = /^\/(v1\/|api\/tags$|config$|clock$|clock\/advance$|records$|check-ins$|check-ins\/[^/]+$)/;

export type ExampleServerOptions = {
  recordsPath: string;
  hypothesis: Hypothesis;
  model: string;
  /** Origin of the OpenAI-compatible runtime; /v1/* and /api/tags are proxied to it. */
  modelUrl: string;
  apiKey?: string;
  /** A clock that can be moved forward, for trying check-ins without waiting days. */
  demo: boolean;
  port?: number;
  /** Serve the app through Vite. Off in tests, which only need the API. */
  vite?: boolean;
  graceFactor?: number;
  /** How often the scheduler looks for expired check-ins. */
  tickMs?: number;
};

export type ExampleServer = {
  url: string;
  store: RecordStore;
  now: () => Date;
  close: () => Promise<void>;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function requireJson(req: IncomingMessage): void {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send the body as application/json');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  requireJson(req);
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not JSON');
  }
}

// The server listens on loopback only, so the caller to keep out is another web
// page open in the same browser. It holds the log and can spend the API key.

/**
 * A page whose domain is re-pointed at 127.0.0.1 (DNS rebinding) counts as
 * same-origin to the browser and could read the log. It still asks for its own
 * name, so only a local name on this port is answered.
 */
export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const at = host.lastIndexOf(':');
  const name = at > host.lastIndexOf(']') ? host.slice(0, at) : host;
  const asked = at > host.lastIndexOf(']') ? host.slice(at + 1) : '80';
  return LOCAL_NAMES.has(name.toLowerCase()) && asked === String(port);
}

/**
 * A page on another site can send a form-style request here without asking.
 * The browser says where a request came from: Origin on every cross-origin
 * request that can carry a body, Sec-Fetch-Site on all of them. Callers that
 * send neither (the CLI, curl) are not pages.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const { origin, host } = req.headers;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = typeof body === 'string' ? JSON.stringify({ error: body }) : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' }).end(json);
}

export async function startExampleServer(options: ExampleServerOptions): Promise<ExampleServer> {
  const { recordsPath } = options;
  const existing = existsSync(recordsPath)
    ? readFileSync(recordsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as LogRecord)
    : [];
  const store = new RecordStore((record) => appendFile(recordsPath, `${JSON.stringify(record)}\n`, 'utf8'), existing);
  const graceFactor = options.graceFactor ?? 2;
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'The model proxy takes GET and POST');
    if (req.method === 'POST') requireJson(req);
    const body = req.method === 'GET' ? undefined : new Uint8Array(await readBody(req));
    let upstream: Response;
    try {
      upstream = await fetch(options.modelUrl.replace(/\/+$/, '') + url.pathname + url.search, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      send(res, 502, `Cannot reach the model at ${options.modelUrl}`);
      return;
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    if (!API_PATH.test(pathname)) return false;
    if (!isSameOrigin(req)) throw new HttpError(403, 'This server only answers its own page');

    if (pathname.startsWith('/v1/') || pathname === '/api/tags') {
      await proxy(req, res, url);
      return true;
    }
    if (pathname === '/config' && method === 'GET') {
      send(res, 200, { model: options.model, demo: options.demo, hypothesis: options.hypothesis, offsetMs });
      return true;
    }
    if (pathname === '/clock' && method === 'GET') {
      send(res, 200, { offsetMs, now: now().toISOString() });
      return true;
    }
    if (pathname === '/clock/advance' && method === 'POST') {
      if (!options.demo) throw new HttpError(404, 'The clock only moves in demo mode');
      const { ms } = (await readJson(req)) as { ms?: unknown };
      if (typeof ms !== 'number' || ms <= 0 || ms > 366 * 86_400_000) throw new HttpError(400, 'ms must be a positive number of milliseconds, at most a year');
      offsetMs += ms;
      await store.expireDue(now(), graceFactor);
      send(res, 200, { offsetMs, now: now().toISOString() });
      return true;
    }
    if (pathname === '/records' && method === 'POST') {
      const result = await store.append(await readJson(req));
      if (!result.ok) throw new HttpError(result.status, result.message);
      send(res, 204);
      return true;
    }
    if (pathname === '/records' && method === 'GET') {
      const count = Math.min(Number(url.searchParams.get('tail') ?? 10) || 10, 50);
      send(res, 200, store.tail(count));
      return true;
    }
    if (pathname === '/check-ins' && method === 'GET') {
      send(res, 200, store.due(now()));
      return true;
    }
    const checkIn = pathname.match(/^\/check-ins\/([^/]+)$/);
    if (checkIn && method === 'POST') {
      const { option_id } = (await readJson(req)) as { option_id?: unknown };
      if (typeof option_id !== 'string') throw new HttpError(400, 'option_id is required');
      const result = await store.close(decodeURIComponent(checkIn[1]!), option_id, now());
      if (!result.ok) throw new HttpError(result.status, result.message);
      send(res, 200, result.record);
      return true;
    }
    return false;
  }

  const server: Server = createServer();
  const vite = options.vite
    ? await (await import('vite')).createServer({
        root: HERE,
        appType: 'spa',
        logLevel: 'warn',
        // No CORS: nothing on another origin, local or not, has a reason to read this one.
        // The log sits in this folder; it is read through GET /records, never as a file.
        server: { middlewareMode: true, hmr: { server }, cors: false, fs: { deny: [...VITE_DENY, '**/records*.jsonl'] } },
      })
    : undefined;

  server.on('request', (req, res) => {
    if (!isLocalHost(req.headers.host, (server.address() as AddressInfo).port)) {
      send(res, 403, 'This server only answers on localhost');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    api(req, res, url)
      .then((handled) => {
        if (handled) return;
        if (vite) vite.middlewares(req, res);
        else send(res, 404, 'Not found');
      })
      .catch((error: unknown) => {
        if (res.headersSent) return res.end();
        send(res, error instanceof HttpError ? error.status : 500, error instanceof Error ? error.message : String(error));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  // The scheduler: expired check-ins close with outcome.source = none. Delivery
  // of due ones is GET /check-ins; a real deployment would notify instead.
  const tick = setInterval(() => void store.expireDue(now(), graceFactor), options.tickMs ?? 60_000);

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    now,
    close: async () => {
      clearInterval(tick);
      await vite?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Tells the person what is missing before they meet it as a prose card.
async function checkModel(modelUrl: string, model: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(new URL('/api/tags', modelUrl), { signal: AbortSignal.timeout(3_000) });
  } catch {
    return `Cannot reach a model at ${modelUrl}. Start Ollama with: ollama serve`;
  }
  if (response.status === 404) return null; // Not Ollama; the adapter will find out.
  const { models } = (await response.json()) as { models?: { name: string }[] };
  const names = models?.map((m) => m.name) ?? [];
  return names.includes(model) || names.includes(`${model}:latest`) ? null : `${model} is not pulled. Run: ollama pull ${model}`;
}

async function main(): Promise<void> {
  const demo = process.argv.includes('--demo');
  const root = join(HERE, '..', '..');
  const model = process.env.LOGBOOK_MODEL ?? 'qwen2.5:7b';
  const modelUrl = process.env.LOGBOOK_MODEL_URL ?? 'http://127.0.0.1:11434';
  const recordsPath = join(HERE, demo ? 'records.demo.jsonl' : 'records.jsonl');
  const port = Number(process.env.LOGBOOK_PORT ?? 5178);

  const warning = await checkModel(modelUrl, model);
  let server: ExampleServer;
  try {
    server = await startExampleServer({
      recordsPath,
      hypothesis: JSON.parse(readFileSync(join(root, 'hypothesis.json'), 'utf8')) as Hypothesis,
      model,
      modelUrl,
      apiKey: process.env.LOGBOOK_API_KEY,
      demo,
      port,
      vite: true,
      tickMs: demo ? 1_000 : 60_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use. Pick another with LOGBOOK_PORT=5179 pnpm example`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`\n  logbook example ${demo ? '(demo clock)' : ''}`);
  console.log(`  ${server.url.replace('127.0.0.1', 'localhost')}`);
  console.log(`  model    ${model} at ${modelUrl}`);
  console.log(`  records  ${recordsPath}`);
  if (warning) console.log(`\n  ! ${warning}`);
  console.log('');

  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (isMain(import.meta.url)) await main();
