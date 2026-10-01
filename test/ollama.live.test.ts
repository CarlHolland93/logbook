// Runs against a real OpenAI-compatible endpoint. Skipped unless LOGBOOK_LIVE is set:
//   pnpm test:live
// Defaults to Ollama on this machine with llama3.2:3b; override with LOGBOOK_BASE_URL and LOGBOOK_MODEL.
import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { Loop } from '../src/loop';
import { buildMessages, TEMPLATE_VERSION } from '../src/template';
import type { Hypothesis, LogRecord } from '../src/types';
import { checkCard, checkRecord } from '../src/validate';

const baseUrl = process.env.LOGBOOK_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const model = process.env.LOGBOOK_MODEL ?? 'llama3.2:3b';

const hypothesis: Hypothesis = {
  context: 'Weekly stock review',
  who: 'Store manager',
  what: 'a supplier delivery that is likely to be late',
  what_changes: 'reorders placed before stock runs out',
  by_how_much: 'stock-outs down 20% in a quarter',
};

const cases = [
  [
    { id: 'ctx_1', text: 'Supplier B delivery delays on the last four orders: 3, 6, 4, 5 days.' },
    { id: 'ctx_2', text: "Stock on hand covers 5 days at this week's sales rate." },
  ],
  [],
  [
    { id: 'ctx_1', text: 'Supplier C has delivered on time for the last 12 orders.' },
    { id: 'ctx_2', text: 'Stock on hand covers 21 days.' },
  ],
  [
    { id: 'ctx_7', text: 'Supplier D is new. No delivery history.' },
    { id: 'ctx_8', text: 'Stock on hand covers 9 days.' },
    { id: 'ctx_9', text: 'A port strike was announced for next week.' },
  ],
];

// Records what the adapter sent, so the tests can see which mode the probe picked.
function spyFetch() {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = ((url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/chat/completions')) bodies.push(JSON.parse(init!.body as string));
    return fetch(url, init);
  }) as typeof fetch;
  return { fetchFn, bodies };
}

describe.skipIf(!process.env.LOGBOOK_LIVE)(`live: ${model} at ${baseUrl}`, { timeout: 180_000 }, () => {
  it('finds structured-output support and builds valid decision cards', async () => {
    const { fetchFn, bodies } = spyFetch();
    const adapter = createOpenAICompatibleAdapter({ baseUrl, model, sampling: { seed: 1 }, fetch: fetchFn });

    const kinds: string[] = [];
    for (const items of cases) {
      const input = buildMessages({ hypothesis, items });
      const { card } = await adapter.compose({ messages: input.messages, hypothesis, retrievalIds: input.retrievalIds });
      expect(checkCard(card)).toEqual([]);
      kinds.push(card.kind);
    }

    // One probe, then one first turn per case, plus a repair turn for any card
    // that failed validation. Every card request carries the schema.
    const [probe, ...cardRequests] = bodies as { messages: { role: string }[]; response_format?: { json_schema: { name: string } } }[];
    expect(probe!.response_format!.json_schema.name).toBe('probe');
    const firstTurns = cardRequests.filter((body) => !body.messages.some((m) => m.role === 'assistant'));
    expect(firstTurns).toHaveLength(cases.length);
    expect(cardRequests.length).toBeLessThanOrEqual(cases.length * 2);
    expect(cardRequests.every((body) => body.response_format?.json_schema.name === 'card')).toBe(true);
    expect(kinds.filter((kind) => kind === 'decision').length).toBeGreaterThanOrEqual(3);
  });

  it('runs the loop end to end and logs the model as the runtime reports it', async () => {
    const records: LogRecord[] = [];
    const loop = new Loop({
      adapter: createOpenAICompatibleAdapter({ baseUrl, model, sampling: { seed: 1 } }),
      sink: { append: (record) => void records.push(record) },
      hypothesis,
    });

    // The first case whose card validates; a prose fallback is abandoned and logged like any other.
    let card = loop.card;
    for (const items of cases) {
      if (card?.kind === 'decision') break;
      if (card) await loop.abandon();
      await loop.compose(buildMessages({ hypothesis, items }));
      card = loop.card;
    }
    if (card?.kind !== 'decision') throw new Error('No case produced a decision card');
    await loop.choose(card.choice.options[0]!.id);
    await loop.outcome({ source: 'self', option_id: 'cant_tell' });

    expect(records.map((r) => r.status).slice(-4)).toEqual(['shown', 'chosen', 'outcome_pending', 'closed']);
    for (const record of records) expect(checkRecord(record)).toEqual([]);
    const last = records.at(-1)!;
    expect(last.model.name).toBe(model);
    expect(last.model.provider).toBe('openai_compatible');
    // Ollama reports a digest; other runtimes report a build fingerprint or nothing.
    if (baseUrl.includes(':11434')) expect(last.model.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(last.input).toMatchObject({ template_version: TEMPLATE_VERSION, sampling: { temperature: 0.2, max_tokens: 800, seed: 1 } });
  });

  it('still returns a valid card of some kind in prompt-only mode', async () => {
    const { fetchFn, bodies } = spyFetch();
    const adapter = createOpenAICompatibleAdapter({ baseUrl, model, structuredOutput: 'prompt_only', sampling: { seed: 1 }, fetch: fetchFn });
    const input = buildMessages({ hypothesis, items: cases[0]! });
    const { card } = await adapter.compose({ messages: input.messages, hypothesis, retrievalIds: input.retrievalIds });

    // One turn, or two if the reply needed a repair; never the schema in this mode.
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies.length).toBeLessThanOrEqual(2);
    for (const body of bodies) expect(body).not.toHaveProperty('response_format');
    expect(checkCard(card)).toEqual([]);
  });

  it('returns a prose card for a model the endpoint does not have', async () => {
    const adapter = createOpenAICompatibleAdapter({ baseUrl, model: 'no-such-model-logbook' });
    const input = buildMessages({ hypothesis, items: [] });
    const { card } = await adapter.compose({ messages: input.messages, hypothesis });
    expect(card).toMatchObject({ kind: 'prose', prose: { reason: 'adapter_error' } });
  });
});
