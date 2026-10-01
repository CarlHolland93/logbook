import type { LoopComposeInput } from './loop';
import type { Hypothesis, Message } from './types';

/** Bump on any change to the wording below: records with different templates are different distributions. */
// t2 (2026-10-01): adds the repair turn.
// t3 (2026-10-01): the person's question, when the card answers one in a conversation.
export const TEMPLATE_VERSION = 't3';

export type ContextItem = { id: string; text: string };

// A worked example beats a description of the shape: small models copy
// placeholder text into the card. It is from an unrelated domain on purpose,
// and the tests check that it is a valid card.
export const EXAMPLE_ITEMS: readonly ContextItem[] = [
  { id: 'a1', text: '140 of 400 tickets sold with 10 days to go.' },
  { id: 'a2', text: 'Last year 300 had sold by this point.' },
];

export const EXAMPLE_REPLY = {
  signal: { headline: 'Ticket sales are well behind last year with 10 days left', level: 'high', confidence: 0.7 },
  evidence: [
    { text: '140 of 400 sold, against 300 at this point last year', basis: 'data', ref: 'a1' },
    { text: 'Most late sales come in the final week', basis: 'rule_of_thumb' },
  ],
  ask: {
    question: 'Is a group booking already promised but not yet paid?',
    kind: 'chips',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  },
  choice: {
    options: [
      { id: 'send_reminder', label: 'Email last year’s buyers', rationale: 'Cheap, and they already know the event' },
      { id: 'extend_discount', label: 'Extend the early price a week' },
      { id: 'wait', label: 'Wait' },
    ],
    recommended: 'send_reminder',
  },
  check_in: {
    question: 'Did sales end up short of 300?',
    due_in: 'P10D',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
    confirms: 'yes',
  },
} as const;

/** The message sent back when a reply fails validation (SPEC §7). Part of the template: changing it bumps the version. */
export function repairMessage(problems: readonly string[]): string {
  return `That reply breaks these rules:
${problems.map((problem) => `- ${problem}`).join('\n')}
Reply with the same card as one JSON object, fixed. Keep everything else as it was.`;
}

const formatItems = (items: readonly ContextItem[]) => items.map((item) => `[${item.id}] ${item.text}`).join('\n');

export type BuildMessagesInput = {
  hypothesis: Hypothesis;
  /** What was looked up for this case. Each item can be cited as data. */
  items: readonly ContextItem[];
  /** What the person asked, when the card is the reply to a message in a conversation. */
  question?: string;
  /** The conversation before that message, oldest first, stored word for word. */
  history?: readonly Message[];
};

/** Builds the full prompt. What this returns is what the record stores as `input.messages`. */
export function buildMessages({ hypothesis, items, question, history = [] }: BuildMessagesInput): LoopComposeInput {
  const system = `You help a ${hypothesis.who} make one decision. Situation: ${hypothesis.context}.
Read the input and judge whether it shows ${hypothesis.what}. It may not: report what the input supports and no more.
The aim is ${hypothesis.what_changes}. Across many decisions, success is measured as: ${hypothesis.by_how_much}.

Reply with one JSON object and nothing else. Here is an example from a different situation. Copy its shape, not its content: your options and questions must fit the input you are given.

Example input:
${formatItems(EXAMPLE_ITEMS)}

Example reply:
${JSON.stringify(EXAMPLE_REPLY, null, 1)}

What each part is:
- "signal" is your reading of this one case. "level" is how strongly the input points to a problem: "low", "medium" or "high". "confidence" is a number from 0 to 1: at most 0.4 for low, 0.3 to 0.7 for medium, at least 0.6 for high.
- "evidence" is 1 to 5 reasons. "basis" is "data", "rule_of_thumb", "you" or "unknown". "ref" is only for "data".
- "ask" is optional: one question about a fact only the person knows, never the decision itself. "kind" is "chips" with 2 to 4 options, or "text" with none.
- "choice" is 2 to 4 actions the person could take now. "recommended" is the id of one of them, or null. "rationale" is optional.
- "check_in" asks later whether what the signal predicted actually happened, with 2 or 3 answers. "confirms" is the id of the answer that means it did. "due_in" is how long until that is known: "P3D" is three days, "P2W" two weeks, "PT12H" twelve hours.
- Every id is short, lower_snake_case and different from the others in its list.
- Labels are 2 to 5 words. Headlines, questions and rationales are one short sentence each, under 120 characters. Evidence text is under 160 characters.

Rules:
1. An evidence line with basis "data" must put the id of the input item it rests on in "ref". Never cite an id that is not in the input.
2. When there is no data for a point, use basis "rule_of_thumb", or "unknown" if you cannot tell, and lower the confidence. Use "you" only for something the person said in the input.
3. Include "ask" only when the answer would change your recommendation.`;

  const input =
    items.length > 0
      ? `Input:\n${formatItems(items)}`
      : 'Input: none. There is no data yet, so work from rules of thumb.';
  const asked = question?.trim();
  const user = asked ? `${input}\n\nThe ${hypothesis.who.toLowerCase()} asks: ${asked}` : input;

  return {
    messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }],
    templateVersion: TEMPLATE_VERSION,
    retrievalIds: items.map((item) => item.id),
  };
}
