import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createMockAdapter, MOCK_OUTPUTS } from '../src/adapters/mock';
import { createOpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { sha256Hex } from '../src/hash';
import { followProblem, Loop, type LoopComposeInput } from '../src/loop';
import { MODEL_DUE_IN_PATTERN, modelCardSchema } from '../src/model-schema';
import { JsonlFileSink } from '../src/sinks/jsonl-file';
import { PostSink } from '../src/sinks/post';
import { buildMessages, EXAMPLE_ITEMS, EXAMPLE_REPLY, repairMessage, TEMPLATE_VERSION } from '../src/template';
import { materialise } from '../scripts/materialise';
import { CARD_VS_CARD_REFUSAL, cardVsCardPairs, signalConfirmed, withinCardPairs } from '../scripts/records-to-pairs';
import { formatReport, MIN_N, reliability, renderSvg } from '../scripts/reliability';
import { synthesise } from '../scripts/synth';
import type { DecisionCard, Hypothesis, LogRecord } from '../src/types';
import { buildCard, checkCard, checkRecord, semanticWarnings, type Problem } from '../src/validate';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const filesIn = (dir: string) => readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith('.json')).sort();

// Each invalid fixture must fail for the reason its name gives, not an incidental one.
const INVALID_CARDS: Record<string, Problem> = {
  'decision-with-prose.json': { path: '/', message: 'must NOT be valid' },
  'confirms-not-in-options.json': { path: '/check_in/confirms', message: '"maybe" is not one of the check-in option ids' },
  'duplicate-option-ids.json': { path: '/choice/options', message: 'duplicate option id "reorder_backup"' },
  'missing-check-in.json': { path: '/', message: "must have required property 'check_in'" },
  'recommended-not-in-options.json': { path: '/choice/recommended', message: '"reorder_now" is not one of the option ids' },
  'six-evidence-lines.json': { path: '/evidence', message: 'must NOT have more than 5 items' },
};

const INVALID_RECORDS: Record<string, Problem> = {
  'answered-without-answer.json': { path: '/', message: "must have required property 'answered'" },
  'closed-without-hypothesis.json': { path: '/input', message: "must have required property 'hypothesis'" },
  'closed-without-source.json': { path: '/outcome', message: "must have required property 'source'" },
  'outcome-pending-without-outcome.json': { path: '/', message: "must have required property 'outcome'" },
};

const decisionFixture = readJson(join(FIXTURES, 'cards/valid/decision.json')) as DecisionCard;

describe('fixtures', () => {
  it.each(filesIn('cards/valid'))('card %s is valid', (file) => {
    expect(checkCard(readJson(join(FIXTURES, 'cards/valid', file)))).toEqual([]);
  });

  it('every invalid card fixture has an expected failure', () => {
    expect(filesIn('cards/invalid')).toEqual(Object.keys(INVALID_CARDS).sort());
  });

  it.each(Object.entries(INVALID_CARDS))('card %s fails', (file, expected) => {
    expect(checkCard(readJson(join(FIXTURES, 'cards/invalid', file)))).toContainEqual(expected);
  });

  it('there is one valid record fixture per status', () => {
    const statuses = filesIn('records/valid').map((f) => (readJson(join(FIXTURES, 'records/valid', f)) as LogRecord).status);
    expect(statuses.sort()).toEqual(['abandoned', 'answered', 'chosen', 'closed', 'expired', 'outcome_pending', 'shown']);
  });

  it.each(filesIn('records/valid'))('record %s is valid', (file) => {
    expect(checkRecord(readJson(join(FIXTURES, 'records/valid', file)))).toEqual([]);
  });

  it('every invalid record fixture has an expected failure', () => {
    expect(filesIn('records/invalid')).toEqual(Object.keys(INVALID_RECORDS).sort());
  });

  it.each(Object.entries(INVALID_RECORDS))('record %s fails', (file, expected) => {
    expect(checkRecord(readJson(join(FIXTURES, 'records/invalid', file)))).toContainEqual(expected);
  });

  it('a record whose card has a bad recommended id fails', () => {
    const record = readJson(join(FIXTURES, 'records/valid/shown.json')) as LogRecord;
    (record.shown.card as DecisionCard).choice.recommended = 'reorder_now';
    expect(checkRecord(record)).toContainEqual({
      path: '/shown/card/choice/recommended',
      message: '"reorder_now" is not one of the option ids',
    });
  });
});

describe('buildCard', () => {
  const { card_id: _id, schema_version: _v, ...modelOutput } = decisionFixture;

  it('adds the adapter-owned fields to a valid model output', () => {
    const { card, problems } = buildCard(modelOutput, 'card_from_adapter', ['ctx_14', 'ctx_15']);
    expect(problems).toEqual([]);
    expect(card).toEqual({ ...decisionFixture, card_id: 'card_from_adapter' });
  });

  it('falls back to prose, keeping the text, when the output is not JSON', () => {
    const { card } = buildCard('Supplier B is late again, reorder.', 'card_garbage1');
    expect(card).toEqual({
      schema_version: '0.1',
      card_id: 'card_garbage1',
      kind: 'prose',
      prose: { text: 'Supplier B is late again, reorder.', reason: 'invalid_json' },
    });
    expect(checkCard(card)).toEqual([]);
  });

  it('falls back to prose on a schema violation and keeps the headline', () => {
    const { check_in: _c, ...noCheckIn } = modelOutput;
    const { card, problems } = buildCard(noCheckIn, 'card_garbage2');
    expect(card).toEqual({
      schema_version: '0.1',
      card_id: 'card_garbage2',
      kind: 'prose',
      prose: { text: decisionFixture.signal.headline, reason: 'schema_violation' },
    });
    expect(problems).toContainEqual({ path: '/', message: "must have required property 'check_in'" });
  });

  it('reports only the rule that broke, not the schema branch around it', () => {
    const { check_in: _c, ...noCheckIn } = modelOutput;
    expect(buildCard(noCheckIn, 'card_exact000').problems).toEqual([{ path: '/', message: "must have required property 'check_in'" }]);
  });

  it('falls back to prose on an id-check failure', () => {
    const output = { ...modelOutput, choice: { ...modelOutput.choice, recommended: 'reorder_now' } };
    expect(buildCard(output, 'card_garbage3').card.kind).toBe('prose');
  });

  it('treats null optional fields as absent, but keeps a null recommendation', () => {
    const output = {
      ...modelOutput,
      ask: null,
      evidence: [{ text: 'Late four times', basis: 'data', ref: 'ctx_14' }, { text: 'Delays repeat', basis: 'rule_of_thumb', ref: null }],
      choice: { ...modelOutput.choice, recommended: null },
    };
    const { card, problems } = buildCard(output, 'card_nulls000', ['ctx_14']);
    expect(problems).toEqual([]);
    expect(card).not.toHaveProperty('ask');
    expect((card as DecisionCard).evidence[1]).toEqual({ text: 'Delays repeat', basis: 'rule_of_thumb' });
    expect((card as DecisionCard).choice.recommended).toBeNull();
  });

  it.each([['[1,2]'], ['null'], ['42'], ['']])('falls back to prose on %j', (raw) => {
    const { card } = buildCard(raw, 'card_garbage4');
    expect(card.kind).toBe('prose');
    expect(checkCard(card)).toEqual([]);
  });
});

describe('semantic checks', () => {
  const card = (patch: Partial<DecisionCard>): DecisionCard => ({ ...structuredClone(decisionFixture), ...patch });
  const codes = (c: DecisionCard, ids: string[] = ['ctx_14', 'ctx_15']) => semanticWarnings(c, ids).map((w) => `${w.code} ${w.path}`);

  it('passes the reference fixture clean', () => {
    expect(codes(decisionFixture)).toEqual([]);
  });

  it('flags a data line whose ref is missing or not in the input', () => {
    expect(codes(decisionFixture, ['ctx_14'])).toEqual(['fabricated_ref /evidence/1']);
    const noRef = card({ evidence: [{ text: 'Late four times', basis: 'data' }] });
    expect(codes(noRef)).toEqual(['fabricated_ref /evidence/0']);
  });

  it('flags basis "you" only when the card asks nothing', () => {
    const evidence = [{ text: 'You said the backup is slow', basis: 'you' as const }];
    expect(codes(card({ evidence }))).toEqual([]);
    const { ask: _a, ...noAsk } = card({ evidence });
    expect(codes(noAsk)).toEqual(['you_without_ask /evidence/0']);
  });

  it.each([
    ['low', 0.4, false],
    ['low', 0.41, true],
    ['medium', 0.3, false],
    ['medium', 0.29, true],
    ['medium', 0.7, false],
    ['medium', 0.71, true],
    ['high', 0.6, false],
    ['high', 0.59, true],
  ] as const)('confidence band: %s at %d → warns %s', (level, confidence, warns) => {
    const c = card({ signal: { headline: 'h', level, confidence } });
    expect(codes(c).includes('confidence_out_of_band /signal/confidence')).toBe(warns);
  });

  // Dropped 2026-10-01: a "no real alternative" check fired on the ordinary act-or-wait card.
  it('does not flag an act-or-wait card', () => {
    const options = [
      { id: 'act_now', label: 'Act now' },
      { id: 'wait', label: 'Wait' },
    ];
    expect(codes(card({ choice: { options, recommended: 'act_now' } }))).toEqual([]);
  });
});

// ── The loop on the mock adapter ─────────────────────────────────────────────

const hypothesis: Hypothesis = {
  context: 'Weekly stock review',
  who: 'Store manager',
  what: 'a supplier delivery that is likely to be late',
  what_changes: 'reorders placed before stock runs out',
  by_how_much: 'stock-outs down 20% in a quarter',
};

const composeInput: LoopComposeInput = {
  messages: [
    { role: 'system', content: 'You assemble one decision card.' },
    { role: 'user', content: '[ctx_14] Delays: 3, 6, 4, 5 days.\n[ctx_15] Stock: 5 days of cover.' },
  ],
  templateVersion: 't1',
  retrievalIds: ['ctx_14', 'ctx_15'],
};

function setup(options: { outputs?: unknown[]; random?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'logbook-'));
  const path = join(dir, 'records.jsonl');
  const clock = { now: new Date('2026-09-30T09:00:00.000Z') };
  let ids = 0;
  const loop = new Loop({
    adapter: createMockAdapter({ outputs: options.outputs ?? [decisionFixture] }),
    sink: new JsonlFileSink(path),
    hypothesis,
    now: () => new Date(clock.now),
    random: () => options.random ?? 0.5,
    newId: () => `rec_${String(++ids).padStart(8, '0')}`,
  });
  const lines = (): LogRecord[] => {
    try {
      return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LogRecord);
    } catch {
      return [];
    }
  };
  const tick = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { loop, lines, tick, clock };
}

const MINUTE = 60_000;
const DAY = 86_400_000;

describe('loop', () => {
  it('runs shown → answered → chosen → outcome_pending → closed and logs five snapshots', async () => {
    const { loop, lines, tick } = setup();

    await loop.compose(composeInput);
    expect(loop.state).toBe('shown');
    tick(MINUTE);
    await loop.answer({ kind: 'chips', option_id: 'no' });
    tick(34_000);
    await loop.choose('reorder_backup');
    expect(loop.state).toBe('outcome_pending');
    tick(7 * DAY);
    await loop.outcome({ source: 'self', option_id: 'no' });

    const log = lines();
    expect(log.map((r) => r.status)).toEqual(['shown', 'answered', 'chosen', 'outcome_pending', 'closed']);
    for (const snapshot of log) expect(checkRecord(snapshot)).toEqual([]);
    expect(log.at(-1)!.chose).toEqual({
      option_id: 'reorder_backup',
      recommended_id: 'reorder_backup',
      agreed: true,
      time_to_choose_ms: 94_000,
      at: '2026-09-30T09:01:34.000Z',
    });
  });

  it('logs an override at the tap and its reason as a later snapshot', async () => {
    const { loop, lines, tick } = setup();

    await loop.compose(composeInput);
    expect(loop.state).toBe('shown');
    tick(MINUTE);
    await loop.answer({ kind: 'chips', option_id: 'no' });
    tick(34_000);
    await loop.choose('chase_supplier');
    tick(20_000);
    await loop.explain('  Supplier B confirmed Friday by phone ');
    expect(loop.state).toBe('outcome_pending');
    tick(7 * DAY);
    await loop.outcome({ source: 'self', option_id: 'no' });

    const log = lines();
    expect(log.map((r) => r.status)).toEqual(['shown', 'answered', 'chosen', 'outcome_pending', 'outcome_pending', 'closed']);
    expect(log[2]!.chose).not.toHaveProperty('override_reason');
    expect(log[4]!.updated_at).toBe('2026-09-30T09:01:54.000Z');
    for (const snapshot of log) expect(checkRecord(snapshot)).toEqual([]);
    expect(new Set(log.map((r) => r.record_id))).toEqual(new Set(['rec_00000001']));

    const last = log.at(-1)!;
    expect(last).toEqual(loop.record);
    expect(last.shown.highlight_shown).toBe(true);
    expect(last.input.context_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(last.input.hypothesis).toEqual(hypothesis);
    expect(last.answered).toEqual({ kind: 'chips', option_id: 'no', at: '2026-09-30T09:01:00.000Z' });
    expect(last.chose).toEqual({
      option_id: 'chase_supplier',
      recommended_id: 'reorder_backup',
      agreed: false,
      override_reason: 'Supplier B confirmed Friday by phone',
      time_to_choose_ms: 94_000,
      at: '2026-09-30T09:01:34.000Z',
    });
    // due_at runs from the tap, not from the reason.
    expect(last.outcome).toEqual({
      source: 'self',
      option_id: 'no',
      due_at: '2026-10-07T09:01:34.000Z',
      at: '2026-10-07T09:01:54.000Z',
    });
    expect(log[3]!.outcome).toEqual({ due_at: '2026-10-07T09:01:34.000Z' });
    expect(log[3]!.updated_at).toBe(log[2]!.updated_at);
  });

  it('refuses to explain an agreement, an empty reason, or twice', async () => {
    const agreed = setup();
    await agreed.loop.compose(composeInput);
    await agreed.loop.choose('reorder_backup');
    await expect(agreed.loop.explain('because')).rejects.toThrow('Only an override');

    const { loop, lines } = setup();
    await loop.compose(composeInput);
    await loop.choose('wait');
    await expect(loop.explain('   ')).rejects.toThrow('cannot be empty');
    await loop.explain('Backup is out of stock too');
    await expect(loop.explain('again')).rejects.toThrow('already explained');
    await loop.outcome({ source: 'self', option_id: 'yes' });
    expect(lines().map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending', 'outcome_pending', 'closed']);
  });

  it('refuses to explain once the record has closed', async () => {
    const { loop } = setup();
    await loop.compose(composeInput);
    await loop.choose('wait');
    await loop.outcome({ source: 'self', option_id: 'no' });
    await expect(loop.explain('late reason')).rejects.toThrow('closed');
  });

  it('records agreed as null when the model recommended nothing', async () => {
    const { loop } = setup({ outputs: [{ ...decisionFixture, choice: { ...decisionFixture.choice, recommended: null } }] });
    await loop.compose(composeInput);
    expect(loop.record!.shown.highlight_shown).toBe(false);
    const record = await loop.choose('wait');
    expect(record.chose).toMatchObject({ recommended_id: null, agreed: null });
    await expect(loop.explain('no reason needed')).rejects.toThrow('Only an override');
  });

  it.each([
    [0.05, false],
    [0.0999, false],
    [0.1, true],
    [0.9, true],
  ])('holdout: random %d → highlight_shown %s', async (random, shown) => {
    const { loop } = setup({ random });
    await loop.compose(composeInput);
    expect(loop.record!.shown.highlight_shown).toBe(shown);
  });

  it('goes straight from shown to chosen when the card has no ask', async () => {
    const { ask: _a, ...noAsk } = decisionFixture;
    const { loop, lines } = setup({ outputs: [noAsk] });
    await loop.compose(composeInput);
    await expect(loop.answer({ kind: 'text', text: 'hi' })).rejects.toThrow('nothing to ask');
    await loop.choose('wait');
    expect(lines().map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending']);
  });

  it('abandons before a choice, and refuses to choose afterwards', async () => {
    const { loop, lines, tick } = setup();
    await loop.compose(composeInput);
    await loop.answer({ kind: 'skipped' });
    tick(30 * MINUTE);
    await loop.abandon();

    const log = lines();
    expect(log.map((r) => r.status)).toEqual(['shown', 'answered', 'abandoned']);
    expect(log.at(-1)!.updated_at).toBe('2026-09-30T09:30:00.000Z');
    expect(checkRecord(log.at(-1))).toEqual([]);
    await expect(loop.choose('wait')).rejects.toThrow('abandoned');
    expect(lines()).toHaveLength(3);
  });

  it('expires an unanswered check-in only after due_at plus twice due_in', async () => {
    const { loop, lines, clock } = setup();
    await loop.compose(composeInput);
    await loop.choose('reorder_backup');
    // due_at = 09:00 + P7D; expiry = due_at + 2 × P7D = 2026-10-21T09:00Z.
    clock.now = new Date('2026-10-21T08:59:59.999Z');
    expect(await loop.expireIfDue()).toBe(false);
    expect(lines()).toHaveLength(3);

    clock.now = new Date('2026-10-21T09:00:00.000Z');
    expect(await loop.expireIfDue()).toBe(true);
    const last = lines().at(-1)!;
    expect(last.status).toBe('expired');
    expect(last.outcome).toEqual({ source: 'none', due_at: '2026-10-07T09:00:00.000Z', at: '2026-10-21T09:00:00.000Z' });
    expect(checkRecord(last)).toEqual([]);
  });

  it('accepts "cant_tell" and rejects an unknown check-in option', async () => {
    const { loop } = setup();
    await loop.compose(composeInput);
    await loop.choose('wait');
    await expect(loop.outcome({ source: 'self', option_id: 'maybe' })).rejects.toThrow('not one of the check-in options');
    const record = await loop.outcome({ source: 'self', option_id: 'cant_tell' });
    expect(record.outcome).toMatchObject({ source: 'self', option_id: 'cant_tell' });
  });

  it('logs a prose fallback and refuses to choose on it', async () => {
    const { loop, lines } = setup({ outputs: ['not json at all'] });
    await loop.compose(composeInput);
    expect(loop.card).toMatchObject({ kind: 'prose', prose: { reason: 'invalid_json' } });
    expect(loop.record!.shown.highlight_shown).toBe(false);
    await expect(loop.choose('wait')).rejects.toThrow('prose card');
    await loop.abandon();
    expect(lines().map((r) => r.status)).toEqual(['shown', 'abandoned']);
  });

  it('refuses to compose over a card that is still waiting on the person', async () => {
    const { loop } = setup();
    await loop.compose(composeInput);
    await expect(loop.compose(composeInput)).rejects.toThrow('call abandon() first');
    expect(loop.state).toBe('shown');
  });

  it('leaves the state alone when the sink fails', async () => {
    const loop = new Loop({
      adapter: createMockAdapter({ outputs: [decisionFixture] }),
      sink: { append: () => Promise.reject(new Error('disk full')) },
      hypothesis,
    });
    await expect(loop.compose(composeInput)).rejects.toThrow('disk full');
    expect(loop.state).toBe('idle');
    expect(loop.record).toBeNull();
  });

  it('surfaces semantic warnings without blocking', async () => {
    const { loop } = setup();
    await loop.compose({ ...composeInput, retrievalIds: ['ctx_14'] });
    expect(loop.state).toBe('shown');
    expect(loop.warnings.map((w) => w.code)).toEqual(['fabricated_ref']);
  });
});

describe('mock adapter', () => {
  it('picks the same output for the same prompt and a fresh card_id each time', async () => {
    const adapter = createMockAdapter();
    const a = await adapter.compose({ messages: composeInput.messages, hypothesis });
    const b = await adapter.compose({ messages: composeInput.messages, hypothesis });
    const { card_id: idA, ...restA } = a.card;
    const { card_id: idB, ...restB } = b.card;
    expect(restA).toEqual(restB);
    expect(idA).not.toBe(idB);
    expect(a.card.kind).toBe('decision');
  });

  it.each([0, 1])('ships built-in output %d as a valid decision card', (i) => {
    const { card, problems } = buildCard(MOCK_OUTPUTS[i], 'card_builtin0');
    expect(problems).toEqual([]);
    expect(card.kind).toBe('decision');
  });
});

// ── What the model is given ──────────────────────────────────────────────────

describe('model-facing schema', () => {
  const schema = modelCardSchema();
  const validate = new Ajv2020().compile(schema);
  const { card_id: _id, schema_version: _v, kind: _k, ...fixtureOutput } = decisionFixture;

  it('leaves out what constrained decoders reject, ignore or misapply', () => {
    const text = JSON.stringify(schema);
    for (const banned of ['"if"', '"then"', '"allOf"', '"not"', '"maxLength"', '(?', 'card_id', 'schema_version', '"kind":{"enum":["decision"']) {
      expect(text).not.toContain(banned);
    }
  });

  it.each([
    ['the decision fixture', fixtureOutput],
    ['mock output 0', MOCK_OUTPUTS[0]],
    ['mock output 1', MOCK_OUTPUTS[1]],
    ['the prompt example', EXAMPLE_REPLY],
  ])('accepts %s', (_name, output) => {
    expect(validate(output)).toBe(true);
  });

  it('requires options on a chips ask', () => {
    expect(validate({ ...fixtureOutput, ask: { question: 'Backup?', kind: 'chips' } })).toBe(false);
    expect(validate({ ...fixtureOutput, ask: { question: 'Backup?', kind: 'text' } })).toBe(true);
  });

  it('only allows durations the full schema also allows', () => {
    const model = new RegExp(MODEL_DUE_IN_PATTERN);
    for (const due_in of ['P3D', 'P2W', 'PT12H', 'PT30M']) {
      expect(model.test(due_in)).toBe(true);
      expect(checkCard({ ...decisionFixture, check_in: { ...decisionFixture.check_in, due_in } })).toEqual([]);
    }
    for (const due_in of ['P', 'PT', 'P1Y2M', '3D', 'P3DT']) expect(model.test(due_in)).toBe(false);
  });

  it('defaults kind to decision, since the model never writes it', () => {
    expect(buildCard(fixtureOutput, 'card_no_kind0').card).toEqual({ ...decisionFixture, card_id: 'card_no_kind0' });
  });
});

describe('prompt template', () => {
  const items = [
    { id: 'ctx_14', text: 'Delays: 3, 6, 4, 5 days.' },
    { id: 'ctx_15', text: 'Stock: 5 days of cover.' },
  ];

  it('gives the model the hypothesis and the input with its ids', () => {
    const input = buildMessages({ hypothesis, items });
    const [system, user] = input.messages;
    expect(input.messages.map((m) => m.role)).toEqual(['system', 'user']);
    for (const slot of Object.values(hypothesis)) expect(system!.content).toContain(slot);
    expect(user!.content).toBe('Input:\n[ctx_14] Delays: 3, 6, 4, 5 days.\n[ctx_15] Stock: 5 days of cover.');
    expect(input.retrievalIds).toEqual(['ctx_14', 'ctx_15']);
    expect(input.templateVersion).toBe(TEMPLATE_VERSION);
  });

  it('adds the person’s question after the input, when the card answers one', () => {
    const input = buildMessages({ hypothesis, items, question: '  Supplier B is late again. Should I reorder? ' });
    expect(input.messages[1]!.content).toBe(
      'Input:\n[ctx_14] Delays: 3, 6, 4, 5 days.\n[ctx_15] Stock: 5 days of cover.\n\nThe store manager asks: Supplier B is late again. Should I reorder?',
    );
    expect(buildMessages({ hypothesis, items: [], question: 'Should I plan for delays?' }).messages[1]!.content).toBe(
      'Input: none. There is no data yet, so work from rules of thumb.\n\nThe store manager asks: Should I plan for delays?',
    );
    expect(buildMessages({ hypothesis, items, question: '   ' }).messages[1]!.content).toBe(buildMessages({ hypothesis, items }).messages[1]!.content);
  });

  it('keeps the earlier turns of the conversation, word for word, before the question', () => {
    const history = [
      { role: 'user' as const, content: 'Anything I should know?' },
      { role: 'assistant' as const, content: 'Supplier B has been late four times.' },
    ];
    const { messages } = buildMessages({ hypothesis, items, question: 'Should I reorder?', history });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages.slice(1, 3)).toEqual(history);
    expect(messages[3]!.content).toMatch(/asks: Should I reorder\?$/);
    expect(messages[0]).toEqual(buildMessages({ hypothesis, items }).messages[0]);
  });

  it('says so when there is no data', () => {
    const input = buildMessages({ hypothesis, items: [] });
    expect(input.messages[1]!.content).toBe('Input: none. There is no data yet, so work from rules of thumb.');
    expect(input.retrievalIds).toEqual([]);
  });

  it('shows the model an example that is itself a clean card', () => {
    const { card, problems, warnings } = buildCard(EXAMPLE_REPLY, 'card_example0', EXAMPLE_ITEMS.map((i) => i.id));
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(card.kind).toBe('decision');
  });

  // Records with different templates are different distributions (SPEC §6.1).
  // If this fails, the wording changed: bump TEMPLATE_VERSION and pin the new hash.
  it('has not changed wording without a version bump', async () => {
    const pinned: Record<string, string> = { t3: '9a57caef7474c03b264161f595e7862846931c7f27e8b830082d5bd511b2c091' };
    const [system, user] = buildMessages({ hypothesis, items, question: 'A question?' }).messages;
    expect(await sha256Hex(system!.content + user!.content + repairMessage(['a problem']))).toBe(pinned[TEMPLATE_VERSION]);
  });
});

// ── OpenAI-compatible adapter, against a fake endpoint ───────────────────────

type Call = { url: string; body: any; headers: Record<string, string> };

function fakeEndpoint(options: {
  reply?: string;
  /** Replies for successive card requests; the last one repeats. */
  replies?: string[];
  status?: number;
  probe?: 'enforced' | 'ignored' | 400;
  digest?: string;
  fingerprint?: string;
}) {
  const calls: Call[] = [];
  const state = { down: false };
  let cardReplies = 0;
  const completion = (content: string) =>
    Response.json({ model: 'test-model:latest', system_fingerprint: options.fingerprint, choices: [{ message: { role: 'assistant', content } }] });

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (state.down) throw new TypeError('fetch failed');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });

    if (String(url).endsWith('/api/tags')) {
      if (!options.digest) return new Response('not found', { status: 404 });
      return Response.json({ models: [{ name: 'test-model:latest', digest: options.digest }] });
    }
    if (body.response_format?.json_schema?.name === 'probe') {
      if (options.probe === 400) return new Response('unknown field', { status: 400 });
      return completion(options.probe === 'ignored' ? 'Hello! How can I help?' : '{"probe":"ok"}');
    }
    if (options.status) return new Response('boom', { status: options.status });
    if (options.replies) return completion(options.replies[Math.min(cardReplies++, options.replies.length - 1)]!);
    return completion(options.reply ?? JSON.stringify(MOCK_OUTPUTS[0]));
  }) as typeof fetch;

  const chats = () => calls.filter((c) => c.url.endsWith('/chat/completions'));
  return {
    fetchFn,
    state,
    probes: () => chats().filter((c) => c.body.response_format?.json_schema?.name === 'probe'),
    cardRequests: () => chats().filter((c) => c.body.response_format?.json_schema?.name !== 'probe'),
  };
}

describe('openai-compatible adapter', () => {
  const { card_id: _id, schema_version: _v, kind: _k, ...fixtureOutput } = decisionFixture;
  const adapterFor = (endpoint: ReturnType<typeof fakeEndpoint>, extra: Partial<Parameters<typeof createOpenAICompatibleAdapter>[0]> = {}) =>
    createOpenAICompatibleAdapter({
      baseUrl: 'http://model.test/v1/',
      model: 'test-model',
      fetch: endpoint.fetchFn,
      newId: () => 'card_adapter1',
      ...extra,
    });
  const compose = (adapter: ReturnType<typeof adapterFor>) =>
    adapter.compose({ messages: composeInput.messages, hypothesis, retrievalIds: composeInput.retrievalIds });

  it('sends the model-facing schema when the endpoint enforces one, and probes once', async () => {
    const endpoint = fakeEndpoint({ reply: JSON.stringify(fixtureOutput), digest: 'abc123', fingerprint: 'fp_test' });
    const adapter = adapterFor(endpoint, { sampling: { seed: 7 } });
    const result = await compose(adapter);
    await compose(adapter);

    expect(endpoint.probes()).toHaveLength(1);
    expect(endpoint.cardRequests()).toHaveLength(2);
    const request = endpoint.cardRequests()[0]!;
    expect(request.url).toBe('http://model.test/v1/chat/completions');
    expect(request.body).toEqual({
      model: 'test-model',
      stream: false,
      messages: composeInput.messages,
      temperature: 0.2,
      max_tokens: 800,
      seed: 7,
      response_format: { type: 'json_schema', json_schema: { name: 'card', schema: JSON.parse(JSON.stringify(modelCardSchema())) } },
    });

    expect(result.card).toEqual({ ...decisionFixture, card_id: 'card_adapter1' });
    expect(result.warnings).toEqual([]);
    expect(result.sampling).toEqual({ temperature: 0.2, max_tokens: 800, seed: 7 });
    expect(result.model).toEqual({
      name: 'test-model:latest',
      version: 'sha256:abc123',
      provider: 'openai_compatible',
      endpoint_hash: (await sha256Hex('http://model.test/v1')).slice(0, 16),
    });
  });

  it.each([['ignored'], [400]] as const)('falls back to prompt-only when the probe is %s', async (probe) => {
    const fenced = 'Here is the card:\n```json\n' + JSON.stringify(fixtureOutput, null, 2) + '\n```\nHope that helps.';
    const endpoint = fakeEndpoint({ probe, reply: fenced, fingerprint: 'fp_test' });
    const result = await compose(adapterFor(endpoint));

    expect(endpoint.cardRequests()[0]!.body).not.toHaveProperty('response_format');
    expect(result.card).toEqual({ ...decisionFixture, card_id: 'card_adapter1' });
    expect(result.model.version).toBe('fp_test');
  });

  it('skips the probe when the mode is set', async () => {
    const endpoint = fakeEndpoint({});
    await compose(adapterFor(endpoint, { structuredOutput: 'json_schema' }));
    await compose(adapterFor(endpoint, { structuredOutput: 'prompt_only' }));
    expect(endpoint.probes()).toHaveLength(0);
    expect(endpoint.cardRequests().map((c) => 'response_format' in c.body)).toEqual([true, false]);
  });

  it('repairs a card that breaks a rule, in one more turn, and says so', async () => {
    const long = { ...fixtureOutput, choice: { ...fixtureOutput.choice, options: fixtureOutput.choice.options.map((o) => (o.id === 'wait' ? { ...o, label: 'Consider switching to a more reliable supplier' } : o)) } };
    const endpoint = fakeEndpoint({ replies: [JSON.stringify(long), JSON.stringify(fixtureOutput)] });
    const result = await compose(adapterFor(endpoint));

    expect(result.card).toEqual({ ...decisionFixture, card_id: 'card_adapter1' });
    expect(result.repair).toEqual({
      problems: ['/choice/options/2/label ("Consider switching to a more reliable supplier") must NOT have more than 40 characters'],
      first_reply: JSON.stringify(long),
    });
    const [firstRequest, repairRequest] = endpoint.cardRequests();
    expect(repairRequest!.body.messages).toEqual([
      ...composeInput.messages,
      { role: 'assistant', content: JSON.stringify(long) },
      { role: 'user', content: repairMessage(result.repair!.problems) },
    ]);
    expect(repairRequest!.body.response_format).toEqual(firstRequest!.body.response_format);
    expect(repairRequest!.body.temperature).toBe(firstRequest!.body.temperature);
    expect(result).not.toHaveProperty('problems');
  });

  it('asks for JSON when the first reply was not JSON', async () => {
    const endpoint = fakeEndpoint({ replies: ['Sure! I would reorder from the backup.', JSON.stringify(fixtureOutput)] });
    const result = await compose(adapterFor(endpoint, { structuredOutput: 'prompt_only' }));
    expect(result.card.kind).toBe('decision');
    expect(result.repair!.problems).toEqual(['The reply was not one JSON object.']);
  });

  it('keeps the attempt on record when the repair fails too', async () => {
    const bad = { ...fixtureOutput, choice: { ...fixtureOutput.choice, recommended: 'reorder_now' } };
    const endpoint = fakeEndpoint({ replies: [JSON.stringify(bad)] });
    const result = await compose(adapterFor(endpoint));
    expect(result.card).toMatchObject({ kind: 'prose', prose: { reason: 'schema_violation' } });
    expect(result.repair!.problems).toEqual(['/choice/recommended ("reorder_now") "reorder_now" is not one of the option ids']);
    expect(endpoint.cardRequests()).toHaveLength(2);
  });

  it('never repairs a good card, and not at all when repair is off', async () => {
    const good = fakeEndpoint({ reply: JSON.stringify(fixtureOutput) });
    expect(await compose(adapterFor(good))).not.toHaveProperty('repair');
    expect(good.cardRequests()).toHaveLength(1);

    const off = fakeEndpoint({ reply: 'not json' });
    const result = await compose(adapterFor(off, { repair: false }));
    expect(result.card.kind).toBe('prose');
    expect(result).not.toHaveProperty('repair');
    expect(off.cardRequests()).toHaveLength(1);
  });

  it('logs the repair with the record', async () => {
    const long = { ...fixtureOutput, signal: { ...fixtureOutput.signal, confidence: 7 } };
    const endpoint = fakeEndpoint({ replies: [JSON.stringify(long), JSON.stringify(fixtureOutput)] });
    const records: LogRecord[] = [];
    const loop = new Loop({ adapter: adapterFor(endpoint), sink: { append: (r) => void records.push(r) }, hypothesis, random: () => 0.5 });
    await loop.compose(composeInput);

    expect(records[0]!.shown.repair).toEqual({ problems: ['/signal/confidence (7) must be <= 1'], first_reply: JSON.stringify(long) });
    expect(records[0]!.input.messages).toEqual(composeInput.messages);
    expect(checkRecord(records[0])).toEqual([]);
    expect(checkRecord({ ...records[0], shown: { ...records[0]!.shown, repair: { problems: [], first_reply: 'x' } } })).toContainEqual({
      path: '/shown/repair/problems',
      message: 'must NOT have fewer than 1 items',
    });
  });

  it('turns garbage into prose and keeps what the model said', async () => {
    const result = await compose(adapterFor(fakeEndpoint({ reply: 'I would reorder from the backup supplier.' })));
    expect(result.card).toEqual({
      schema_version: '0.1',
      card_id: 'card_adapter1',
      kind: 'prose',
      prose: { text: 'I would reorder from the backup supplier.', reason: 'invalid_json' },
    });
  });

  it('turns a card that breaks the rules into prose', async () => {
    const bad = { ...fixtureOutput, choice: { ...fixtureOutput.choice, recommended: 'reorder_now' } };
    const result = await compose(adapterFor(fakeEndpoint({ reply: JSON.stringify(bad) })));
    expect(result.card).toMatchObject({ kind: 'prose', prose: { text: decisionFixture.signal.headline, reason: 'schema_violation' } });
  });

  it('returns a prose card when the endpoint errors', async () => {
    const result = await compose(adapterFor(fakeEndpoint({ status: 500 })));
    expect(result.card).toMatchObject({ kind: 'prose', prose: { text: 'The model could not be reached: HTTP 500.', reason: 'adapter_error' } });
    expect(result.model).toMatchObject({ name: 'test-model', provider: 'openai_compatible' });
    expect(checkCard(result.card)).toEqual([]);
  });

  it('retries the probe after the endpoint was unreachable', async () => {
    const endpoint = fakeEndpoint({ reply: JSON.stringify(fixtureOutput) });
    const adapter = adapterFor(endpoint);
    endpoint.state.down = true;
    expect((await compose(adapter)).card).toMatchObject({ prose: { text: 'The model could not be reached: no connection.', reason: 'adapter_error' } });

    endpoint.state.down = false;
    expect((await compose(adapter)).card.kind).toBe('decision');
    expect(endpoint.probes()).toHaveLength(1);
    expect(endpoint.cardRequests()[0]!.body).toHaveProperty('response_format');
  });

  it('sends the API key only when there is one', async () => {
    const withKey = fakeEndpoint({});
    await compose(adapterFor(withKey, { apiKey: 'secret' }));
    expect(withKey.cardRequests()[0]!.headers).toMatchObject({ authorization: 'Bearer secret' });

    const without = fakeEndpoint({});
    await compose(adapterFor(without));
    expect(without.cardRequests()[0]!.headers).not.toHaveProperty('authorization');
  });

  it('runs the whole loop and logs what the endpoint reported', async () => {
    const endpoint = fakeEndpoint({ reply: JSON.stringify(fixtureOutput), digest: 'abc123' });
    const records: LogRecord[] = [];
    const loop = new Loop({ adapter: adapterFor(endpoint, { sampling: { seed: 7 } }), sink: { append: (r) => void records.push(r) }, hypothesis, random: () => 0.5 });
    await loop.compose(buildMessages({ hypothesis, items: [{ id: 'ctx_14', text: 'Delays' }, { id: 'ctx_15', text: 'Stock' }] }));
    await loop.choose('wait');

    const last = records.at(-1)!;
    expect(records.map((r) => r.status)).toEqual(['shown', 'chosen', 'outcome_pending']);
    expect(last.model).toMatchObject({ name: 'test-model:latest', version: 'sha256:abc123', provider: 'openai_compatible' });
    expect(last.input).toMatchObject({ template_version: TEMPLATE_VERSION, sampling: { temperature: 0.2, max_tokens: 800, seed: 7 }, retrieval_ids: ['ctx_14', 'ctx_15'] });
    expect(loop.warnings).toEqual([]);
  });
});

// ── Scripts ──────────────────────────────────────────────────────────────────

const fixtureRecord = (name: string) => readJson(join(FIXTURES, 'records/valid', `${name}.json`)) as LogRecord;
// The valid record fixtures are one record's lifecycle; in this order they are a log.
const fixtureLog = ['shown', 'answered', 'chosen', 'outcome-pending', 'closed'].map(fixtureRecord);

describe('synthesise', () => {
  it('drives the real loop: every snapshot is valid and every status occurs', async () => {
    const log = await synthesise({ count: 200, seed: 1 });
    expect(log.length).toBeGreaterThan(200);
    for (const snapshot of log) expect(checkRecord(snapshot)).toEqual([]);
    expect(new Set(log.map((r) => r.status))).toEqual(
      new Set(['shown', 'answered', 'chosen', 'outcome_pending', 'closed', 'expired', 'abandoned']),
    );
    expect(materialise(log)).toHaveLength(200);
  });

  it('is deterministic for a seed', async () => {
    const [a, b, c] = await Promise.all([synthesise({ count: 20, seed: 3 }), synthesise({ count: 20, seed: 3 }), synthesise({ count: 20, seed: 4 })]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('materialise', () => {
  it('keeps the last snapshot per record, in first-seen order', () => {
    const latest = materialise(fixtureLog);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.status).toBe('closed');

    const other = { ...fixtureRecord('shown'), record_id: 'rec_other001' };
    expect(materialise([other, ...fixtureLog, { ...other, status: 'abandoned' as const }]).map((r) => [r.record_id, r.status])).toEqual([
      ['rec_other001', 'abandoned'],
      ['rec_5d20a7e4', 'closed'],
    ]);
  });
});

describe('records-to-pairs', () => {
  it('emits one within-card pair per rejected option on the fixture log', () => {
    const pairs = withinCardPairs(fixtureLog);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.rejected.id)).toEqual(['reorder_backup', 'wait']);
    expect(pairs[0]).toMatchObject({
      kind: 'within_card',
      record_id: 'rec_5d20a7e4',
      chosen: { id: 'chase_supplier', label: 'Chase Supplier B' },
      recommended_id: 'reorder_backup',
      highlight_shown: true,
      agreed: false,
      override_reason: 'Supplier B confirmed Friday by phone',
      time_to_choose_ms: 94000,
      status: 'closed',
      repaired: false,
      signal_confirmed: false,
    });
  });

  it('marks pairs from a repaired card', () => {
    const log = fixtureLog.map((r) => ({ ...r, shown: { ...r.shown, repair: { problems: ['/signal/confidence (7) must be <= 1'], first_reply: '{}' } } }));
    expect(withinCardPairs(log).map((p) => p.repaired)).toEqual([true, true]);
  });

  it('emits nothing for a record with no choice', () => {
    expect(withinCardPairs([fixtureRecord('shown'), fixtureRecord('abandoned')])).toEqual([]);
  });

  it('counts pairs on the synthetic log as (options - 1) per chosen record', async () => {
    const log = await synthesise({ count: 200, seed: 1 });
    const chosen = materialise(log).filter((r) => r.chose);
    expect(chosen.length).toBeGreaterThan(150);
    expect(withinCardPairs(log)).toHaveLength(chosen.length * 2);
  });

  it('refuses card-vs-card pairs', () => {
    expect(() => cardVsCardPairs()).toThrow(CARD_VS_CARD_REFUSAL);
  });

  it.each([
    ['closed', false],
    ['expired', undefined],
    ['outcome-pending', undefined],
  ] as const)('reads the signal outcome from a %s record as %s', (name, expected) => {
    expect(signalConfirmed(fixtureRecord(name))).toBe(expected);
  });

  it('treats cant_tell as unknown and the confirming option as true', () => {
    const closed = fixtureRecord('closed');
    expect(signalConfirmed({ ...closed, outcome: { ...closed.outcome!, option_id: 'cant_tell' } })).toBeUndefined();
    expect(signalConfirmed({ ...closed, outcome: { ...closed.outcome!, option_id: 'yes' } })).toBe(true);
  });
});

describe('reliability', () => {
  it('bins every decision card and scores only closed yes/no check-ins', async () => {
    const log = await synthesise({ count: 200, seed: 1 });
    const report = reliability(log);
    const latest = materialise(log);

    expect(report.records).toBe(200);
    expect(report.decisionCards).toBe(200);
    expect(report.bins.reduce((n, b) => n + b.shown, 0)).toBe(200);
    expect(report.bins.reduce((n, b) => n + b.scored, 0)).toBe(latest.filter((r) => signalConfirmed(r) !== undefined).length);
    for (const b of report.bins) {
      expect(b.confirmed).toBeLessThanOrEqual(b.scored);
      expect(b.agreedHighlighted).toBeLessThanOrEqual(b.highlighted);
      expect(b.agreedHeldOut).toBeLessThanOrEqual(b.heldOut);
    }
    // The synthetic world confirms more often at high confidence.
    const first = report.bins[0]!;
    const last = report.bins.at(-1)!;
    expect(last.confirmed / last.scored).toBeGreaterThan(first.confirmed / first.scored);

    const withRecommendation = latest.filter((r) => r.chose && r.chose.agreed !== null);
    expect(report.bins.reduce((n, b) => n + b.highlighted, 0)).toBe(withRecommendation.filter((r) => r.shown.highlight_shown).length);
    expect(report.bins.reduce((n, b) => n + b.heldOut, 0)).toBe(withRecommendation.filter((r) => !r.shown.highlight_shown).length);
    expect(report.bins.reduce((n, b) => n + b.heldOut, 0)).toBeGreaterThan(0);

    const chosen = latest.filter((r) => r.chose).length;
    expect(report.options.map((o) => o.shown)).toEqual([chosen, chosen, chosen]);
    expect(report.options.reduce((n, o) => n + o.chosen, 0)).toBe(chosen);
  });

  it('names an option nobody picked', () => {
    const report = reliability(fixtureLog);
    expect(formatReport(report)).toMatch(/reorder_backup\s+1\s+0%\s+never picked/);
    expect(formatReport(report)).toMatch(/chase_supplier\s+1\s+100%/);
  });

  it('draws only rates with enough cases', async () => {
    const svg = renderSvg(reliability(await synthesise({ count: 200, seed: 1 })));
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain(`fewer than ${MIN_N} cases`);
    // One case in the fixture log: a marker for it is not drawn, but the legend still names the series.
    const tiny = renderSvg(reliability(fixtureLog));
    expect(tiny).not.toContain('<circle');
    expect(tiny).toContain('Signal confirmed at check-in');
  });
});

describe('loop subscription', () => {
  it('notifies on every change with a new snapshot object', async () => {
    const { loop } = setup();
    const seen: string[] = [];
    const snapshots = new Set<unknown>();
    const unsubscribe = loop.subscribe(() => {
      seen.push(loop.snapshot.state);
      snapshots.add(loop.snapshot);
    });
    const before = loop.snapshot;

    await loop.compose(composeInput);
    expect(loop.snapshot).toBe(loop.snapshot);
    await loop.choose('wait');
    await loop.explain('Backup is out of stock too');
    unsubscribe();
    await loop.outcome({ source: 'self', option_id: 'no' });

    expect(seen).toEqual(['composing', 'shown', 'chosen', 'outcome_pending', 'outcome_pending']);
    expect(snapshots.size).toBe(5);
    expect(before).toEqual({ state: 'idle', record: null, card: null, warnings: [] });
    expect(loop.snapshot).toMatchObject({ state: 'closed', card: loop.card, record: loop.record });
  });

  it('notifies the revert when compose fails', async () => {
    const loop = new Loop({
      adapter: createMockAdapter({ outputs: [decisionFixture] }),
      sink: { append: () => Promise.reject(new Error('disk full')) },
      hypothesis,
    });
    const seen: string[] = [];
    loop.subscribe(() => seen.push(loop.snapshot.state));
    await expect(loop.compose(composeInput)).rejects.toThrow('disk full');
    expect(seen).toEqual(['composing', 'idle']);
  });
});

describe('loop concurrency', () => {
  it('refuses a transition while another is still being saved', async () => {
    const { loop, lines } = setup();
    await loop.compose(composeInput);
    const [first, second] = await Promise.allSettled([loop.choose('wait'), loop.choose('chase_supplier')]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: new Error('Another change to this record is still being saved') });
    expect(lines().map((r) => `${r.status}:${r.chose?.option_id ?? ''}`)).toEqual(['shown:', 'chosen:wait', 'outcome_pending:wait']);
  });

  it('frees the loop after a failed transition', async () => {
    const { loop } = setup();
    await loop.compose(composeInput);
    await expect(loop.choose('no_such_option')).rejects.toThrow('not one of the choice options');
    await expect(loop.choose('wait')).resolves.toMatchObject({ status: 'outcome_pending' });
  });
});

describe('PostSink', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (status = 200) =>
    (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status });
    }) as typeof fetch;

  it('POSTs each snapshot as JSON, with keepalive for a normal-sized record', async () => {
    calls.length = 0;
    const record = readJson(join(FIXTURES, 'records/valid/shown.json')) as LogRecord;
    await new PostSink('https://records.test/log', { fetch: fakeFetch(), headers: { authorization: 'Bearer t' } }).append(record);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://records.test/log');
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(record);
  });

  it('drops keepalive for a record over the browser limit rather than failing', async () => {
    calls.length = 0;
    const record = readJson(join(FIXTURES, 'records/valid/shown.json')) as LogRecord;
    record.input.messages = [{ role: 'user', content: 'x'.repeat(70_000) }];
    await new PostSink('https://records.test/log', { fetch: fakeFetch() }).append(record);
    expect(calls[0]!.init.keepalive).toBe(false);
  });

  it('rejects when the server does, so the loop does not advance', async () => {
    const loop = new Loop({
      adapter: createMockAdapter({ outputs: [decisionFixture] }),
      sink: new PostSink('https://records.test/log', { fetch: fakeFetch(503) }),
      hypothesis,
    });
    await expect(loop.compose(composeInput)).rejects.toThrow('The record server answered HTTP 503');
    expect(loop.state).toBe('idle');
  });
});

describe('followProblem', () => {
  it('accepts every consecutive pair the loop itself writes', async () => {
    const log = await synthesise({ count: 60, seed: 2 });
    const previous = new Map<string, LogRecord>();
    for (const snapshot of log) {
      expect(followProblem(previous.get(snapshot.record_id), snapshot)).toBeNull();
      previous.set(snapshot.record_id, snapshot);
    }
  });

  it.each([
    ['a record that starts mid-way', undefined, 'closed', 'must start as shown'],
    ['a second choice', 'outcome-pending', 'chosen', 'cannot become chosen'],
    ['a write after closing', 'closed', 'outcome_pending', 'cannot become outcome_pending'],
    ['a skipped step', 'shown', 'closed', 'cannot become closed'],
  ] as const)('refuses %s', (_name, from, to, message) => {
    const next = { ...fixtureRecord(to === 'outcome_pending' ? 'outcome-pending' : to === 'chosen' ? 'chosen' : to), status: to };
    expect(followProblem(from ? fixtureRecord(from) : undefined, next)).toContain(message);
  });

  it('refuses a second reason and a record that changed its card', () => {
    // The fixture already carries a reason; start from the unexplained state.
    const { override_reason: _r, ...unexplained } = fixtureRecord('outcome-pending').chose!;
    const pending = { ...fixtureRecord('outcome-pending'), chose: unexplained };
    const explained = { ...pending, chose: { ...unexplained, override_reason: 'Supplier confirmed by phone' } };
    expect(followProblem(pending, explained)).toBeNull();
    expect(followProblem(explained, { ...explained, chose: { ...explained.chose!, override_reason: 'again' } })).toContain('only an unexplained override');
    expect(followProblem(pending, { ...fixtureRecord('closed'), card_id: 'card_other000' })).toContain('card or creation time');
  });

  it('refuses a snapshot older than the one before it', () => {
    const closed = fixtureRecord('closed');
    const pending = fixtureRecord('outcome-pending');
    expect(followProblem(pending, { ...closed, updated_at: '2026-09-29T00:00:00.000Z' })).toBe('updated_at went backwards');
  });
});
