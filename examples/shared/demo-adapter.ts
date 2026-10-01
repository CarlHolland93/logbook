import { buildCard } from '../../src/validate';
import type { Adapter, ComposeResult, Hypothesis } from '../../src/types';
import { buildMessages } from '../../src/template';
import { PRESETS, presetItems } from './presets';

// What a model might write for each preset: model-facing shape, no adapter-owned fields.
export const DEMO_OUTPUTS: Readonly<Record<string, unknown>> = {
  'Late supplier, low stock': {
    signal: { headline: 'The next delivery is likely to land after stock runs out', level: 'high', confidence: 0.74 },
    evidence: [
      { text: 'The last four deliveries were 3 to 6 days late', basis: 'data', ref: 'ctx_1' },
      { text: 'Stock covers about 5 days at this rate', basis: 'data', ref: 'ctx_2' },
      { text: 'Delays this long tend to repeat for a few weeks', basis: 'rule_of_thumb' },
    ],
    ask: {
      question: 'Is there a backup supplier you could order from this week?',
      kind: 'chips',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
        { id: 'not_sure', label: 'Not sure' },
      ],
    },
    choice: {
      options: [
        { id: 'reorder_backup', label: 'Reorder from backup', rationale: 'Covers the gap if B is late again' },
        { id: 'chase_supplier', label: 'Chase Supplier B for a date', rationale: 'Cheaper if B can commit' },
        { id: 'wait', label: 'Wait' },
      ],
      recommended: 'reorder_backup',
    },
    check_in: {
      question: 'Did you run out of stock before the delivery arrived?',
      due_in: 'P7D',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'yes',
    },
  },
  'Reliable supplier': {
    signal: { headline: 'No sign this delivery will be late', level: 'low', confidence: 0.15 },
    evidence: [
      { text: 'On time for the last 12 orders', basis: 'data', ref: 'ctx_1' },
      { text: 'Stock covers 21 days', basis: 'data', ref: 'ctx_2' },
    ],
    choice: {
      options: [
        { id: 'keep_schedule', label: 'Keep the usual schedule' },
        { id: 'reorder_early', label: 'Reorder early anyway', rationale: 'Only worth it if demand is about to jump' },
      ],
      recommended: 'keep_schedule',
    },
    check_in: {
      question: 'Did the delivery arrive late?',
      due_in: 'P2W',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'yes',
    },
  },
  'New supplier, port strike': {
    signal: { headline: 'The strike could hold up a first delivery from a new supplier', level: 'medium', confidence: 0.55 },
    evidence: [
      { text: 'Supplier D has no delivery history yet', basis: 'data', ref: 'ctx_1' },
      { text: 'A port strike starts next week', basis: 'data', ref: 'ctx_3' },
      { text: 'Stock covers 9 days', basis: 'data', ref: 'ctx_2' },
      { text: 'Strikes usually delay shipments by a week or more', basis: 'rule_of_thumb' },
    ],
    ask: { question: 'Has Supplier D given you a delivery date?', kind: 'text' },
    choice: {
      options: [
        { id: 'confirm_date', label: 'Ask Supplier D for a date', rationale: 'Settles it before the strike starts' },
        { id: 'reorder_backup', label: 'Reorder from backup' },
        { id: 'wait', label: 'Wait' },
      ],
      recommended: 'confirm_date',
    },
    check_in: {
      question: 'Was the delivery held up by the strike?',
      due_in: 'P10D',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'yes',
    },
  },
  'No data yet': {
    signal: { headline: 'Too early to tell if this delivery will be late', level: 'low', confidence: 0.3 },
    evidence: [
      { text: 'New orders are often a few days late', basis: 'rule_of_thumb' },
      { text: 'No delivery history for this supplier yet', basis: 'unknown' },
    ],
    ask: { question: 'When did the supplier say it would arrive?', kind: 'text' },
    choice: {
      options: [
        { id: 'ask_for_date', label: 'Ask for a firm date' },
        { id: 'wait', label: 'Wait' },
      ],
      recommended: 'ask_for_date',
    },
    check_in: {
      question: 'Did it arrive later than promised?',
      due_in: 'P1W',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'yes',
    },
  },
};

export type DemoAdapterOptions = {
  hypothesis: Hypothesis;
  /** How long a card "takes", so the building state is visible. */
  delayMs?: () => number;
  newId?: () => string;
};

/**
 * A stand-in model for the hosted demo: the card written for whichever preset
 * the prompt was built from, and the no-data card for anything else. Goes
 * through buildCard like a real reply, so the same validation applies.
 */
export function createDemoAdapter({ hypothesis, delayMs = () => 700 + Math.random() * 500, newId = () => crypto.randomUUID() }: DemoAdapterOptions): Adapter {
  const byPrompt = new Map(
    PRESETS.map((preset) => {
      const input = buildMessages({ hypothesis, items: presetItems(preset), question: preset.question, history: preset.lead });
      return [input.messages.at(-1)!.content, preset.name];
    }),
  );

  return {
    async compose(input): Promise<ComposeResult> {
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs()));
      const preset = byPrompt.get(input.messages.at(-1)?.content ?? '') ?? 'No data yet';
      const { card, warnings } = buildCard(DEMO_OUTPUTS[preset], newId(), input.retrievalIds);
      return {
        card,
        warnings,
        model: { name: 'stand-in', version: 'demo', provider: 'mock' },
        sampling: { temperature: 0 },
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}
