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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not JSON');
  }
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

  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'GET' ? undefined : new Uint8Array(await readBody(req));
    let upstream: Response;
    try {
      upstream = await fetch(options.modelUrl.replace(/\/+$/, '') + req.url, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
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

    if (pathname.startsWith('/v1/') || pathname === '/api/tags') {
      await proxy(req, res);
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
        server: { middlewareMode: true, hmr: { server } },
      })
    : undefined;

  server.on('request', (req, res) => {
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
