import { contextHash } from '../hash';
import { buildCard } from '../validate';
import type { Adapter, ComposeInput, ComposeResult } from '../types';

// Raw model outputs, as a model would return them: they match modelCardSchema(), with no adapter-owned fields.
// One card with data, one day-one card with only rules of thumb.
export const MOCK_OUTPUTS: readonly unknown[] = [
  {
    signal: { headline: 'The next delivery is likely to arrive after stock runs out', level: 'high', confidence: 0.72 },
    evidence: [
      { text: 'Last four deliveries arrived 3 to 6 days late', basis: 'data', ref: 'ctx_1' },
      { text: 'Current stock covers about 5 days at this rate', basis: 'data', ref: 'ctx_2' },
      { text: 'Delays this long usually repeat for a few weeks', basis: 'rule_of_thumb' },
    ],
    ask: {
      question: 'Is there a backup supplier you could use this week?',
      kind: 'chips',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
        { id: 'not_sure', label: 'Not sure' },
      ],
    },
    choice: {
      options: [
        { id: 'reorder_backup', label: 'Reorder from backup', rationale: 'Covers the gap if the delay repeats' },
        { id: 'chase_supplier', label: 'Chase the supplier', rationale: 'Cheaper if they can confirm a date' },
        { id: 'wait', label: 'Wait' },
      ],
      recommended: 'reorder_backup',
    },
    check_in: {
      question: 'Did you run out of stock before the next delivery?',
      due_in: 'P7D',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'yes',
    },
  },
  {
    signal: { headline: 'This delivery might be late', level: 'low', confidence: 0.3 },
    evidence: [
      { text: 'New suppliers are often late on their first few orders', basis: 'rule_of_thumb' },
      { text: 'No delivery history for this supplier yet', basis: 'unknown' },
    ],
    ask: { question: 'Has this supplier told you a delivery date?', kind: 'text' },
    choice: {
      options: [
        { id: 'confirm_date', label: 'Ask for a date' },
        { id: 'reorder_backup', label: 'Reorder from backup' },
        { id: 'wait', label: 'Wait' },
      ],
      recommended: 'confirm_date',
    },
    check_in: {
      question: 'Did the delivery arrive on time?',
      due_in: 'P3D',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      confirms: 'no',
    },
  },
];

export type MockAdapterOptions = {
  /** Raw outputs to pick from; strings are parsed as model text. Defaults to MOCK_OUTPUTS. */
  outputs?: readonly unknown[];
  newId?: () => string;
};

/** Returns fixture cards, picked deterministically by the prompt's context hash. */
export function createMockAdapter({ outputs = MOCK_OUTPUTS, newId = () => crypto.randomUUID() }: MockAdapterOptions = {}): Adapter {
  if (outputs.length === 0) throw new Error('Mock adapter needs at least one output');

  return {
    async compose(input: ComposeInput): Promise<ComposeResult> {
      const started = performance.now();
      const hash = await contextHash(input.messages);
      const raw = outputs[Number.parseInt(hash.slice(7, 15), 16) % outputs.length];
      const { card, warnings } = buildCard(raw, newId(), input.retrievalIds);
      return {
        card,
        model: { name: 'mock', version: '0.1', provider: 'mock' },
        sampling: { temperature: 0 },
        latencyMs: Math.round(performance.now() - started),
        warnings,
      };
    },
  };
}
