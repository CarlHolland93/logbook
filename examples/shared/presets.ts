import type { Message } from '../../src/types';

export type PresetIcon = 'clock' | 'check' | 'anchor' | 'plus';

export type Preset = {
  name: string;
  /** A few words for the chip that starts this conversation. */
  label: string;
  icon: PresetIcon;
  /** How the conversation opens, before it reaches a decision. */
  lead: readonly Message[];
  /** The message that reaches the decision; the card is the reply to it. */
  question: string;
  /** What the assistant finds when it looks. */
  facts: readonly string[];
  /** Where each fact comes from, in a few words; shown while the assistant looks it up. */
  sources: readonly string[];
};

/** The example conversations: a store manager talking to the store's assistant. */
export const PRESETS: readonly Preset[] = [
  {
    name: 'Late supplier, low stock',
    label: 'Late supplier',
    icon: 'clock',
    lead: [
      { role: 'user', content: 'Morning. Anything I should know before I place this week\u2019s orders?' },
      { role: 'assistant', content: 'Two things. Supplier B has been late on each of its last four deliveries, and their lines are down to about five days of stock. Everything else looks normal.' },
    ],
    question: 'Supplier B is late again. Should I reorder?',
    facts: ['Supplier B delivery delays on the last four orders: 3, 6, 4, 5 days.', "Stock on hand covers 5 days at this week's sales rate."],
    sources: ['Supplier B delivery history', 'Stock on hand'],
  },
  {
    name: 'Reliable supplier',
    label: 'Reliable supplier',
    icon: 'check',
    lead: [
      { role: 'user', content: 'I\u2019m planning next week. How are deliveries looking?' },
      { role: 'assistant', content: 'Mostly steady. Supplier C has a delivery due Tuesday, and stock on their lines covers about three weeks.' },
    ],
    question: "Do I need to worry about Supplier C's next delivery?",
    facts: ['Supplier C has delivered on time for the last 12 orders.', 'Stock on hand covers 21 days.'],
    sources: ['Supplier C delivery history', 'Stock on hand'],
  },
  {
    name: 'New supplier, port strike',
    label: 'Port strike',
    icon: 'anchor',
    lead: [
      { role: 'user', content: 'I saw there\u2019s a port strike coming. Does it touch us?' },
      { role: 'assistant', content: 'It could. Supplier D ships through that port, and their first order with us is due the week it starts.' },
    ],
    question: "What should I do about Supplier D's order?",
    facts: ['Supplier D is new. No delivery history.', 'Stock on hand covers 9 days.', 'A port strike was announced for next week.'],
    sources: ['Supplier D delivery history', 'Stock on hand', 'Shipping notices'],
  },
  {
    name: 'No data yet',
    label: 'New supplier',
    icon: 'plus',
    lead: [
      { role: 'user', content: 'We signed a new supplier yesterday.' },
      { role: 'assistant', content: 'Noted. I have no delivery history for them yet, so for now I can only go on rules of thumb.' },
    ],
    question: 'Should I plan for their first delivery to be late?',
    facts: [],
    sources: [],
  },
];

export const presetItems = (preset: Preset) => preset.facts.map((text, i) => ({ id: `ctx_${i + 1}`, text }));
