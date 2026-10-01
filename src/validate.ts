import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import cardSchema from '../schema/card.schema.json';
import recordSchema from '../schema/record.schema.json';
import type { Card, DecisionCard, Option, ProseCard, ProseReason, Warning } from './types';

export type Problem = { path: string; message: string };

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
ajv.addSchema(cardSchema);
const cardValidator = ajv.getSchema(cardSchema.$id)!;
const recordValidator = ajv.compile(recordSchema);

/** The confidence range each level stands for (SPEC §5.2). The overlap is deliberate. */
export const CONFIDENCE_BANDS: Readonly<Record<DecisionCard['signal']['level'], readonly [number, number]>> = {
  low: [0, 0.4],
  medium: [0.3, 0.7],
  high: [0.6, 1],
};

const PROSE_MAX = 1200;
const FALLBACK_TEXT = "The model's answer couldn't be shown as a card.";

function schemaProblems(validate: typeof cardValidator, value: unknown): Problem[] {
  if (validate(value)) return [];
  // An "if" error only says a "then" failed; the error that explains why is reported beside it.
  return (validate.errors ?? []).filter((e) => e.keyword !== 'if').map((e) => ({ path: e.instancePath || '/', message: e.message ?? e.keyword }));
}

// The structural rules JSON Schema can't express: they compare one field to another (SPEC §5.1).
function idProblems(card: DecisionCard, prefix = ''): Problem[] {
  const problems: Problem[] = [];
  const groups: [string, Option[] | undefined][] = [
    ['/choice/options', card.choice.options],
    ['/ask/options', card.ask?.options],
    ['/check_in/options', card.check_in.options],
  ];
  for (const [path, options] of groups) {
    const seen = new Set<string>();
    for (const { id } of options ?? []) {
      if (seen.has(id)) problems.push({ path: prefix + path, message: `duplicate option id "${id}"` });
      seen.add(id);
    }
  }
  const { recommended, options } = card.choice;
  if (recommended !== null && !options.some((o) => o.id === recommended)) {
    problems.push({ path: prefix + '/choice/recommended', message: `"${recommended}" is not one of the option ids` });
  }
  const { confirms } = card.check_in;
  if (!card.check_in.options.some((o) => o.id === confirms)) {
    problems.push({ path: prefix + '/check_in/confirms', message: `"${confirms}" is not one of the check-in option ids` });
  }
  return problems;
}

/** Structural validity of a card: schema plus id checks. Empty means the card may be rendered. */
export function checkCard(value: unknown): Problem[] {
  const problems = schemaProblems(cardValidator, value);
  if (problems.length > 0) return problems;
  const card = value as Card;
  return card.kind === 'decision' ? idProblems(card) : [];
}

/** Structural validity of one record snapshot, including the id checks on every card it holds. */
export function checkRecord(value: unknown): Problem[] {
  const problems = schemaProblems(recordValidator, value);
  if (problems.length > 0) return problems;
  const { shown } = value as { shown: { card: Card; candidates?: Card[] } };
  const cards = [shown.card, ...(shown.candidates ?? [])];
  return cards.flatMap((card, i) =>
    card.kind === 'decision' ? idProblems(card, i === 0 ? '/shown/card' : `/shown/candidates/${i - 1}`) : [],
  );
}

/** The three semantic checks (SPEC §5.2). Logged, never blocking. */
export function semanticWarnings(card: DecisionCard, retrievalIds: readonly string[] = []): Warning[] {
  const warnings: Warning[] = [];
  const known = new Set(retrievalIds);

  card.evidence.forEach((line, i) => {
    const path = `/evidence/${i}`;
    if (line.basis === 'data' && (line.ref === undefined || !known.has(line.ref))) {
      warnings.push({
        code: 'fabricated_ref',
        path,
        message: line.ref === undefined ? 'data line has no ref' : `ref "${line.ref}" is not in the input`,
      });
    }
    if (line.basis === 'you' && card.ask === undefined) {
      warnings.push({ code: 'you_without_ask', path, message: 'basis "you" on a card that asks nothing' });
    }
  });

  const { level, confidence } = card.signal;
  const [lo, hi] = CONFIDENCE_BANDS[level];
  if (confidence < lo || confidence > hi) {
    warnings.push({
      code: 'confidence_out_of_band',
      path: '/signal/confidence',
      message: `${confidence} is outside the band for level "${level}"`,
    });
  }

  return warnings;
}

export function proseCard(cardId: string, text: string, reason: ProseReason): ProseCard {
  return {
    schema_version: '0.1',
    card_id: cardId,
    kind: 'prose',
    prose: { text: (text.trim() || FALLBACK_TEXT).slice(0, PROSE_MAX), reason },
  };
}

// Models write `"ask": null` or `"ref": null` for a field they leave empty. That is
// JSON for "absent", so it is dropped before validation. `recommended` keeps its
// null, which means "no recommendation".
function withoutNulls<T>(node: T): T {
  if (Array.isArray(node)) return node.map(withoutNulls) as T;
  if (typeof node !== 'object' || node === null) return node;
  const entries = Object.entries(node).filter(([key, value]) => value !== null || key === 'recommended');
  return Object.fromEntries(entries.map(([key, value]) => [key, withoutNulls(value)])) as T;
}

export type BuiltCard = { card: Card; warnings: Warning[]; problems: Problem[] };

/**
 * Turns raw model output into a card the UI can always render. The adapter owns
 * `card_id`, `schema_version` and `kind`; anything that fails structural checks becomes prose.
 */
export function buildCard(raw: unknown, cardId: string, retrievalIds?: readonly string[]): BuiltCard {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        card: proseCard(cardId, raw, 'invalid_json'),
        warnings: [],
        problems: [{ path: '/', message: 'not valid JSON' }],
      };
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      card: proseCard(cardId, FALLBACK_TEXT, 'schema_violation'),
      warnings: [],
      problems: [{ path: '/', message: 'must be object' }],
    };
  }

  // The model only ever writes decision cards; prose is made here, by the fallback.
  const candidate = { kind: 'decision', ...withoutNulls(value), schema_version: '0.1', card_id: cardId };
  const problems = checkCard(candidate);
  if (problems.length > 0) {
    const headline = (candidate as { signal?: { headline?: unknown } }).signal?.headline;
    const text = typeof headline === 'string' ? headline : FALLBACK_TEXT;
    return { card: proseCard(cardId, text, 'schema_violation'), warnings: [], problems };
  }

  const card = candidate as Card;
  const warnings = card.kind === 'decision' ? semanticWarnings(card, retrievalIds) : [];
  return { card, warnings, problems: [] };
}
