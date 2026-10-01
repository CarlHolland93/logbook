// Synthetic records.jsonl for the scripts, made by driving the real loop.
//   pnpm synth [count] [seed] > records.jsonl
//
// The world behind it is deliberately imperfect: the model is overconfident at
// the top of the range, the highlight nudges people, and some check-ins go
// unanswered. That is what the reliability plot is meant to show.
import { Loop } from '../src/loop';
import { isMain, writeJsonl } from './cli';
import type { Adapter, ComposeInput, ComposeResult, DecisionCard, Hypothesis, LogRecord } from '../src/types';

export const SYNTH_HYPOTHESIS: Hypothesis = {
  context: 'Weekly stock review',
  who: 'Store manager',
  what: 'a supplier delivery that is likely to be late',
  what_changes: 'reorders placed before stock runs out',
  by_how_much: 'stock-outs down 20% in a quarter',
};

// Same shape as SPEC §8: each scenario is one context the card appears in.
const SCENARIOS = [
  { context: 'Supplier B delivery delays on the last four orders: 3, 6, 4, 5 days. Stock covers 5 days.', headline: 'The next delivery is likely to arrive after stock runs out' },
  { context: 'Supplier C has delivered on time for the last 12 orders. Stock covers 21 days.', headline: 'No sign of a late delivery' },
  { context: 'Supplier D is new. No delivery history. A port strike was announced for next week.', headline: 'A late first delivery is possible' },
  { context: 'Supplier E confirmed Friday by phone. Stock covers 4 days.', headline: 'The delivery should land before stock runs out' },
];

const OPTIONS = [
  { id: 'reorder_backup', label: 'Reorder from backup' },
  { id: 'chase_supplier', label: 'Chase the supplier' },
  { id: 'wait', label: 'Wait' },
];

const OVERRIDE_REASONS = ['Supplier confirmed a date by phone', 'Backup is out of stock too', 'Sales are slower this week'];

/** True probability that the signal comes true, given the model's confidence. Overconfident above 0.6. */
export const WORLD_CONFIRMED_RATE = (confidence: number) => 0.1 + 0.7 * confidence;

/** Chance of agreeing with the recommendation: the highlight adds a nudge on top of confidence. */
export const WORLD_AGREE_RATE = (confidence: number, highlightShown: boolean) =>
  highlightShown ? 0.45 + 0.45 * confidence : 0.35 + 0.35 * confidence;

// Small, seedable, good enough for a fixture.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticAdapter(random: () => number, newId: () => string): Adapter {
  return {
    async compose(input: ComposeInput): Promise<ComposeResult> {
      const scenario = Number(input.messages[1]!.content.match(/\[ctx_(\d)\]/)![1]);
      const confidence = Math.round((0.05 + random() * 0.9) * 100) / 100;
      const level = confidence <= 0.35 ? 'low' : confidence < 0.65 ? 'medium' : 'high';
      const recommended = random() < 0.1 ? null : OPTIONS[Math.floor(random() * OPTIONS.length)]!.id;
      const card: DecisionCard = {
        schema_version: '0.1',
        card_id: newId(),
        kind: 'decision',
        signal: { headline: SCENARIOS[scenario]!.headline, level, confidence },
        evidence: [
          { text: SCENARIOS[scenario]!.context, basis: 'data', ref: `ctx_${scenario}` },
          { text: 'Delays this long usually repeat for a few weeks', basis: 'rule_of_thumb' },
        ],
        ...(random() < 0.5
          ? { ask: { question: 'Is there a backup supplier you could use this week?', kind: 'chips', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } }
          : {}),
        choice: { options: OPTIONS, recommended },
        check_in: {
          question: 'Did the delivery arrive after stock ran out?',
          due_in: 'P7D',
          options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
          confirms: 'yes',
        },
      };
      return { card, model: { name: 'synthetic', provider: 'mock' }, sampling: { temperature: 0 }, latencyMs: 0, warnings: [] };
    },
  };
}

export type SynthOptions = { count?: number; seed?: number; start?: Date };

/** Every snapshot of `count` decisions, in the order a real log would hold them. */
export async function synthesise({ count = 200, seed = 1, start = new Date('2026-06-01T09:00:00Z') }: SynthOptions = {}): Promise<LogRecord[]> {
  const random = mulberry32(seed);
  let ids = 0;
  const newId = () => `syn_${seed}_${String(++ids).padStart(5, '0')}`;
  const clock = { now: new Date(start) };
  const tick = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  const log: LogRecord[] = [];

  const loop = new Loop({
    adapter: syntheticAdapter(random, newId),
    sink: { append: (record) => void log.push(record) },
    hypothesis: SYNTH_HYPOTHESIS,
    now: () => new Date(clock.now),
    random,
    newId,
    actor: { user_hash: 'u_synthetic', role: 'Store manager' },
  });

  for (let i = 0; i < count; i++) {
    const scenario = Math.floor(random() * SCENARIOS.length);
    await loop.compose({
      messages: [
        { role: 'system', content: 'synthetic' },
        { role: 'user', content: `[ctx_${scenario}] ${SCENARIOS[scenario]!.context}` },
      ],
      templateVersion: 'synthetic',
      retrievalIds: [`ctx_${scenario}`],
    });
    const card = loop.card as DecisionCard;
    const { confidence } = card.signal;
    const highlight = loop.record!.shown.highlight_shown;

    if (card.ask) {
      tick(2_000 + random() * 20_000);
      await loop.answer(random() < 0.7 ? { kind: 'chips', option_id: random() < 0.5 ? 'yes' : 'no' } : { kind: 'skipped' });
    }

    const decisionAt = clock.now.getTime();
    if (random() < 0.1) {
      tick(30 * 60_000);
      await loop.abandon();
    } else {
      // Fast taps on a highlighted card; slower when reading is needed.
      tick(highlight && random() < 0.3 ? 400 + random() * 800 : 3_000 + random() * 120_000);
      const { recommended } = card.choice;
      const agrees = recommended !== null && random() < WORLD_AGREE_RATE(confidence, highlight);
      const others = OPTIONS.filter((o) => o.id !== recommended);
      const choice = agrees ? recommended! : others[Math.floor(random() * others.length)]!.id;
      // Only an override against a real recommendation can be explained.
      const overrode = recommended !== null && !agrees;
      const reason = overrode && random() < 0.6 ? OVERRIDE_REASONS[Math.floor(random() * OVERRIDE_REASONS.length)] : undefined;
      await loop.choose(choice);
      if (reason) {
        tick(5_000 + random() * 25_000);
        await loop.explain(reason);
      }

      const ending = random();
      if (ending < 0.72) {
        tick(7 * 86_400_000 + random() * 86_400_000);
        const cantTell = random() < 0.1;
        const confirmed = random() < WORLD_CONFIRMED_RATE(confidence);
        await loop.outcome({ source: 'self', option_id: cantTell ? 'cant_tell' : confirmed ? 'yes' : 'no' });
      } else if (ending < 0.85) {
        tick(22 * 86_400_000);
        await loop.expireIfDue();
      }
    }
    // Next decision starts a little later than this one did, so the log stays in time order.
    clock.now = new Date(decisionAt + 37 * 60_000 + random() * 60_000);
  }
  return log;
}

if (isMain(import.meta.url)) {
  const [count, seed] = process.argv.slice(2).map(Number);
  writeJsonl(await synthesise({ count: count || 200, seed: seed || 1 }));
}
