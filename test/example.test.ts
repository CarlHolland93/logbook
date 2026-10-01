// The example's record server, end to end over HTTP: a real Loop in Node,
// talking to the model through the server's proxy and logging through PostSink.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askedIn, linesWritten, stored } from '../examples/shared/App';
import { createDemoAdapter, DEMO_OUTPUTS } from '../examples/shared/demo-adapter';
import { localBackend } from '../examples/shared/local-backend';
import { PRESETS, presetItems } from '../examples/shared/presets';
import { RecordStore } from '../examples/shared/record-store';
import { startExampleServer, type ExampleServer } from '../examples/local-model/server';
import { createOpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { Loop } from '../src/loop';
import { PostSink } from '../src/sinks/post';
import { buildMessages } from '../src/template';
import type { DecisionCard, Hypothesis, LogRecord } from '../src/types';
import { checkRecord } from '../src/validate';

const ROOT = join(import.meta.dirname, '..');
const hypothesis = JSON.parse(readFileSync(join(ROOT, 'hypothesis.json'), 'utf8')) as Hypothesis;
const decisionFixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/cards/valid/decision.json'), 'utf8')) as DecisionCard;
const { card_id: _id, schema_version: _v, kind: _k, ...modelOutput } = decisionFixture;
const DAY = 86_400_000;

// A stand-in for Ollama: answers the probe, then returns the fixture card.
async function fakeModel() {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server: Server = createServer(async (req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    if (req.url === '/api/tags') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'test-model:latest', digest: 'abc' }] }));
    let body = '';
    for await (const chunk of req) body += chunk;
    const probe = JSON.parse(body).response_format?.json_schema?.name === 'probe';
    const content = probe ? '{"probe":"ok"}' : JSON.stringify(modelOutput);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'test-model:latest', choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start(extra: { demo?: boolean; apiKey?: string; modelUrl?: string } = {}) {
  const model = await fakeModel();
  const recordsPath = join(mkdtempSync(join(tmpdir(), 'logbook-example-')), 'records.jsonl');
  const server: ExampleServer = await startExampleServer({
    recordsPath,
    hypothesis,
    model: 'test-model',
    modelUrl: extra.modelUrl ?? model.url,
    apiKey: extra.apiKey,
    demo: extra.demo ?? true,
    vite: false,
    tickMs: 20,
  });
  cleanups.push(model.close, server.close);

  const loop = new Loop({
    adapter: createOpenAICompatibleAdapter({ baseUrl: `${server.url}/v1`, model: 'test-model' }),
    sink: new PostSink(`${server.url}/records`),
    hypothesis,
    random: () => 0.5,
    now: server.now,
  });
  const lines = () =>
    readFileSync(recordsPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LogRecord);
  const post = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async <T,>(path: string) => (await (await fetch(`${server.url}${path}`)).json()) as T;
  const input = buildMessages({ hypothesis, items: [{ id: 'ctx_14', text: 'Delays' }, { id: 'ctx_15', text: 'Stock' }] });
  return { server, model, loop, lines, post, get, input, recordsPath };
}

describe('example record server', () => {
  it('logs a whole decision through the proxy, and delivers the check-in when it is due', async () => {
    const { loop, lines, post, get, input } = await start();
    await loop.compose(input);
    await loop.choose('chase_supplier');
    await loop.explain('Supplier confirmed Friday by phone');
    const id = loop.record!.record_id;

    expect(loop.card!.kind).toBe('decision');
    expect(loop.record!.model).toMatchObject({ name: 'test-model:latest', version: 'sha256:abc' });
    expect(await get<LogRecord[]>('/check-ins')).toEqual([]);

    expect((await post('/clock/advance', { ms: 7 * DAY })).status).toBe(200);
    const due = await get<LogRecord[]>('/check-ins');
    expect(due.map((r) => r.record_id)).toEqual([id]);

    const closed = await post(`/check-ins/${id}`, { option_id: 'cant_tell' });
    expect(closed.status).toBe(200);
    expect(await get<LogRecord[]>('/check-ins')).toEqual([]);

    const log = lines();
    expect(log.map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending', 'outcome_pending', 'closed']);
    for (const snapshot of log) expect(checkRecord(snapshot)).toEqual([]);
    expect(log.at(-1)!.outcome).toMatchObject({ source: 'self', option_id: 'cant_tell' });
    expect(log.at(-1)!.chose!.override_reason).toBe('Supplier confirmed Friday by phone');
  });

  it('refuses a stale or doubled write, and the loop does not advance on it', async () => {
    const { loop, lines, post, input } = await start();
    await loop.compose(input);
    await loop.choose('wait');
    const [, chosen] = lines();

    const again = await post('/records', chosen);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('a outcome_pending record cannot become chosen');

    await post(`/check-ins/${loop.record!.record_id}`, { option_id: 'no' });
    await expect(loop.outcome({ source: 'self', option_id: 'yes' })).rejects.toThrow('HTTP 409');
    expect(loop.state).toBe('outcome_pending');
    expect(lines().map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending', 'closed']);
  });

  it('refuses a record that does not match the schema', async () => {
    const { post } = await start();
    const response = await post('/records', { schema_version: '0.1', status: 'shown' });
    expect(response.status).toBe(400);
  });

  it('expires an unanswered check-in once due plus twice due_in has passed', async () => {
    const { loop, lines, post } = await start();
    await loop.compose(buildMessages({ hypothesis, items: [] }));
    await loop.choose('wait');

    await post('/clock/advance', { ms: 21 * DAY - 60_000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(lines().at(-1)!.status).toBe('outcome_pending');

    await post('/clock/advance', { ms: 60_000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(lines().at(-1)).toMatchObject({ status: 'expired', outcome: { source: 'none' } });
  });

  it('lets only one of two simultaneous writes to a record through', async () => {
    const { loop, lines, post, input } = await start();
    await loop.compose(input);
    const shown = loop.record!;
    const choice = (option_id: string) => ({
      ...shown,
      status: 'chosen',
      updated_at: new Date(Date.parse(shown.updated_at) + 1000).toISOString(),
      chose: { option_id, recommended_id: 'reorder_backup', agreed: option_id === 'reorder_backup', time_to_choose_ms: 1000, at: new Date(Date.parse(shown.updated_at) + 1000).toISOString() },
    });
    const statuses = (await Promise.all([post('/records', choice('wait')), post('/records', choice('reorder_backup'))])).map((r) => r.status);

    expect(statuses.sort()).toEqual([204, 409]);
    expect(lines().filter((r) => r.status === 'chosen')).toHaveLength(1);
  });

  it('expires check-ins on its own timer, without the clock being moved', async () => {
    const { server, lines } = await start();
    // A decision made a month ago on the server's own clock, never checked in.
    const monthAgo = () => new Date(server.now().getTime() - 30 * DAY);
    const old = new Loop({
      adapter: createOpenAICompatibleAdapter({ baseUrl: `${server.url}/v1`, model: 'test-model' }),
      sink: new PostSink(`${server.url}/records`),
      hypothesis,
      random: () => 0.5,
      now: monthAgo,
    });
    await old.compose(buildMessages({ hypothesis, items: [] }));
    await old.choose('wait');

    await new Promise((r) => setTimeout(r, 80));
    expect(lines().at(-1)).toMatchObject({ status: 'expired', outcome: { source: 'none' } });
  });

  it('keeps the clock still outside demo mode', async () => {
    const { post } = await start({ demo: false });
    expect((await post('/clock/advance', { ms: DAY })).status).toBe(404);
  });

  it('adds the API key on the way to the model, never in the browser', async () => {
    const { loop, model, input } = await start({ apiKey: 'secret-key' });
    await loop.compose(input);
    const chat = model.seen.filter((s) => s.url === '/v1/chat/completions');
    expect(chat.length).toBeGreaterThan(0);
    for (const request of chat) expect(request.headers.authorization).toBe('Bearer secret-key');
  });

  it('answers 502 when the model is unreachable, so the card falls back to prose', async () => {
    const { loop, input } = await start({ modelUrl: 'http://127.0.0.1:9' });
    await loop.compose(input);
    expect(loop.card).toMatchObject({ kind: 'prose', prose: { reason: 'adapter_error', text: 'The model could not be reached: HTTP 502.' } });
  });

  it('reloads the log on restart and carries on from the latest snapshot', async () => {
    const { server: first, loop: firstLoop, input: firstInput, recordsPath: firstPath } = await start();
    await firstLoop.compose(firstInput);
    await firstLoop.choose('wait');
    await first.close();
    const restarted = await startExampleServer({ recordsPath: firstPath, hypothesis, model: 'test-model', modelUrl: 'http://127.0.0.1:9', demo: true, vite: false });
    cleanups.push(restarted.close);
    expect(restarted.store.get(firstLoop.record!.record_id)!.status).toBe('outcome_pending');

    const { loop, recordsPath, input } = await start();
    await loop.compose(input);
    await loop.choose('wait');
    const reopened = new RecordStore(() => {}, readFileSync(recordsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogRecord));
    expect(reopened.get(loop.record!.record_id)!.status).toBe('outcome_pending');
    expect(reopened.pending()).toHaveLength(1);
    expect(reopened.tail(10).map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending']);
  });
});

// ── The hosted demo's pieces, which run in the browser ───────────────────────

describe('demo stand-in model', () => {
  it.each(PRESETS.map((p) => [p.name, p] as const))('writes a clean card for "%s"', async (name, preset) => {
    const input = buildMessages({ hypothesis, items: presetItems(preset), question: preset.question, history: preset.lead });
    const result = await createDemoAdapter({ hypothesis, delayMs: () => 0 }).compose({ ...input, hypothesis });

    expect(result.card.kind).toBe('decision');
    expect(result.warnings).toEqual([]);
    expect((result.card as DecisionCard).signal).toEqual((DEMO_OUTPUTS[name] as DecisionCard).signal);
  });

  it('answers anything else with the no-data card', async () => {
    const input = buildMessages({ hypothesis, items: [{ id: 'ctx_1', text: 'Something nobody planned for.' }] });
    const result = await createDemoAdapter({ hypothesis, delayMs: () => 0 }).compose({ ...input, hypothesis });
    expect((result.card as DecisionCard).signal.headline).toBe((DEMO_OUTPUTS['No data yet'] as DecisionCard).signal.headline);
  });
});

describe('demo backend', () => {
  function demo() {
    const backend = localBackend({ config: { title: 'Open Sourced Learning', modelLabel: 'stand-in', demo: true, hypothesis, autoStart: true, editableFacts: false }, adapter: createDemoAdapter({ hypothesis, delayMs: () => 0 }), tickMs: 20 });
    cleanups.push(async () => backend.stop());
    const loop = new Loop({ adapter: backend.adapter, sink: backend.sink, hypothesis, random: () => 0.5, now: () => new Date(Date.now() + backend.offsetMs()) });
    const preset = (name: string) => {
      const found = PRESETS.find((p) => p.name === name)!;
      return buildMessages({ hypothesis, items: presetItems(found), question: found.question, history: found.lead });
    };
    return { backend, loop, preset };
  }

  it('runs a decision to a closed check-in, all in memory', async () => {
    const { backend, loop, preset } = demo();
    await loop.compose(preset('Late supplier, low stock'));
    await loop.choose('chase_supplier');
    await loop.explain('Supplier B confirmed by phone');
    expect((await backend.snapshot()).due).toEqual([]);

    await backend.advanceClock(7 * DAY);
    const { due, offsetMs } = await backend.snapshot();
    expect(due.map((r) => r.record_id)).toEqual([loop.record!.record_id]);
    expect(offsetMs).toBe(7 * DAY);
    expect(backend.lines.map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending', 'outcome_pending']);

    await backend.closeCheckIn(loop.record!.record_id, 'no');
    expect((await backend.snapshot()).due).toEqual([]);
    const lines = backend.download!().trim().split('\n').map((l) => JSON.parse(l) as LogRecord);
    expect(lines.map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending', 'outcome_pending', 'closed']);
    for (const line of lines) expect(checkRecord(line)).toEqual([]);
  });

  it('refuses the same stale write the server would', async () => {
    const { backend, loop, preset } = demo();
    await loop.compose(preset('Reliable supplier'));
    await loop.choose('keep_schedule');
    await expect(backend.sink.append(backend.lines[1]!)).rejects.toThrow('cannot become chosen');
    await expect(backend.closeCheckIn('no-such-record', 'yes')).rejects.toThrow('No record');
  });

  it('expires unanswered check-ins when the clock moves past the grace period', async () => {
    const { backend, loop, preset } = demo();
    await loop.compose(preset('No data yet'));
    await loop.choose('wait');
    await backend.advanceClock(21 * DAY);
    expect(backend.lines.at(-1)).toMatchObject({ status: 'expired', outcome: { source: 'none' } });
  });

  it('downloads nothing before anything happened', () => {
    expect(demo().backend.download!()).toBe('');
  });
});

describe('what is stored, in plain words beside its field', () => {
  const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, 'fixtures/records/valid', `${name}.json`), 'utf8')) as LogRecord;
  const fields = (record: LogRecord) => stored(record).map((entry) => entry.field);
  const entry = (record: LogRecord, field: string) => stored(record).find((e) => e.field === field);
  const inChat = (record: LogRecord) => {
    const preset = PRESETS[0]!;
    const { messages, retrievalIds } = buildMessages({ hypothesis, items: presetItems(preset), question: preset.question, history: preset.lead });
    return { ...record, input: { ...record.input, messages, retrieval_ids: retrievalIds } };
  };

  it('adds an entry for each thing stored, and none for what has not happened yet', () => {
    expect(fields(fixture('shown'))).toEqual(['input.messages', 'shown.card']);
    expect(fields(fixture('answered'))).toEqual(['input.messages', 'shown.card', 'answered']);
    expect(fields(fixture('chosen'))).toEqual(['input.messages', 'shown.card', 'answered', 'chose', 'chose.override_reason']);
    expect(fields(fixture('outcome-pending'))).toEqual(['input.messages', 'shown.card', 'answered', 'chose', 'chose.override_reason', 'outcome.due_at']);
    expect(fields(fixture('closed'))).toEqual(['input.messages', 'shown.card', 'answered', 'chose', 'chose.override_reason', 'outcome']);
  });

  it('names only fields the record really has', () => {
    const closed = fixture('closed') as unknown as Record<string, unknown>;
    for (const field of fields(fixture('closed')).concat(fields(fixture('outcome-pending')))) {
      const value = field.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], closed);
      expect(value, field).toBeDefined();
    }
  });

  it('shows the conversation as stored: every turn in order, and the instructions by size', () => {
    const conversation = entry(inChat(fixture('shown')), 'input.messages')!;
    expect(conversation.messages!.map((m) => m.role)).toEqual(['Instructions', 'You', 'Assistant', 'You']);
    expect(conversation.messages![0]!.text).toMatch(/^What the model is told to do \([\d,]+ characters\)$/);
    expect(conversation.messages![1]!.text).toBe(PRESETS[0]!.lead[0]!.content);
    expect(conversation.messages![2]!.text).toBe(PRESETS[0]!.lead[1]!.content);
    // The last message is stored with the looked-up records; the panel shows what the person typed.
    expect(conversation.messages![3]!.text).toBe('Supplier B is late again. Should I reorder?');
    expect(conversation.detail).toBe('Plus the 2 records the assistant looked up.');
    expect(askedIn(fixture('shown'))).toBeUndefined();
  });

  it('says each stored thing plainly', () => {
    const closed = fixture('closed');
    expect(entry(closed, 'shown.card')!.value).toBe('High confidence. Recommended “Reorder from backup”.');
    expect(entry(closed, 'answered')!.value).toBe('“No”');
    expect(entry(closed, 'chose')).toMatchObject({ value: '“Chase Supplier B”. You overrode the recommendation.', detail: 'Decided in 2 min.' });
    expect(entry(closed, 'chose.override_reason')!.value).toBe('“Supplier B confirmed Friday by phone”');
    // The fixture's check-in asks "Did you run out of stock?", confirms "yes", and was answered "no".
    expect(entry(closed, 'outcome')!.value).toBe('“No”. The model’s signal did not come true.');
    expect(entry({ ...fixture('answered'), answered: { kind: 'skipped', at: closed.updated_at } }, 'answered')!.value).toBe('You skipped its question.');
  });

  it('marks only a scheduled follow-up as still to come', () => {
    const pending = stored(fixture('outcome-pending'));
    expect(pending.at(-1)).toMatchObject({ field: 'outcome.due_at', label: 'Follow-up', pending: true });
    expect(pending.filter((e) => e.pending)).toHaveLength(1);
    expect(stored(fixture('closed')).some((e) => e.pending)).toBe(false);
  });

  it('says when the signal came true, when the person could not tell, and when nobody answered', () => {
    const closed = fixture('closed');
    const withAnswer = (option_id: string) => entry({ ...closed, outcome: { ...closed.outcome!, option_id } }, 'outcome')!.value;
    expect(withAnswer('yes')).toBe('“Yes”. The model’s signal came true.');
    expect(withAnswer('cant_tell')).toBe('You could not tell.');
    expect(entry(fixture('expired'), 'outcome')!.value).toBe('No answer. The follow-up expired.');
  });

  it('keeps a held-out recommendation hidden until the choice is made', () => {
    const shown = fixture('shown');
    const heldOut = { ...shown, shown: { ...shown.shown, highlight_shown: false } };
    const before = entry(heldOut, 'shown.card')!;
    expect(before.value).toBe('High confidence.');
    expect(before.detail).toContain('hid the recommendation until you chose');
    expect(JSON.stringify(stored(heldOut))).not.toContain('Reorder from backup');

    const chosen = fixture('chosen');
    expect(entry({ ...chosen, shown: { ...chosen.shown, highlight_shown: false } }, 'shown.card')!.value).toBe('High confidence. Recommended “Reorder from backup”.');
  });

  it('describes a card set aside and a fallback card', () => {
    expect(fields(fixture('abandoned'))).toEqual(['input.messages', 'shown.card', 'status']);
    expect(entry(fixture('abandoned'), 'status')!.value).toBe('None. You set the card aside.');

    const shown = fixture('shown');
    const prose = { ...shown, shown: { ...shown.shown, card: { schema_version: '0.1' as const, card_id: shown.card_id, kind: 'prose' as const, prose: { text: 'Reorder.' } } } };
    expect(stored(prose).map((e) => e.value)).toEqual([undefined, 'Its reply broke the card’s rules, so it was shown as plain text.']);
  });

  it('counts the lines a record has added to the log, one per snapshot', () => {
    // The fixtures are one record's lifecycle: shown, answered, chosen, outcome_pending, then closed.
    expect(linesWritten(fixture('shown'))).toBe(1);
    expect(linesWritten(fixture('answered'))).toBe(2);
    expect(linesWritten(fixture('abandoned'))).toBe(2);
  });

  it('counts the same lines the loop really writes', async () => {
    const backend = localBackend({ config: { title: 'Open Sourced Learning', modelLabel: 'stand-in', demo: true, hypothesis, autoStart: true, editableFacts: false }, adapter: createDemoAdapter({ hypothesis, delayMs: () => 0 }), tickMs: 20 });
    cleanups.push(async () => backend.stop());
    const loop = new Loop({ adapter: backend.adapter, sink: backend.sink, hypothesis, random: () => 0.5, now: () => new Date(Date.now() + backend.offsetMs()) });
    const preset = PRESETS[0]!;
    const check = () => expect(linesWritten(loop.record!)).toBe(backend.lines.length);

    await loop.compose(buildMessages({ hypothesis, items: presetItems(preset), question: preset.question, history: preset.lead }));
    check();
    await loop.answer({ kind: 'chips', option_id: 'no' });
    check();
    await loop.choose('chase_supplier');
    check();
    await loop.explain('Supplier B confirmed by phone');
    check();
    await loop.outcome({ source: 'self', option_id: 'no' });
    check();
    expect(backend.lines).toHaveLength(6);
  });
});
