import cardSchema from '../schema/card.schema.json';

// One unit only, so the pattern needs no lookahead. A subset of the full card schema's pattern.
export const MODEL_DUE_IN_PATTERN = '^P([0-9]+[DW]|T[0-9]+[HM])$';

// Constrained decoders enforce maxLength by cutting text off mid-word, which
// yields a valid-looking broken card. The prompt states the limits instead and
// the full schema rejects anything over them.
function withoutMaxLength<T>(node: T): T {
  if (Array.isArray(node)) return node.map(withoutMaxLength) as T;
  if (typeof node !== 'object' || node === null) return node;
  const entries = Object.entries(node).filter(([key]) => key !== 'maxLength');
  return Object.fromEntries(entries.map(([key, value]) => [key, withoutMaxLength(value)])) as T;
}

/**
 * The schema handed to the model for constrained decoding. Derived from
 * card.schema.json, minus what runtimes reject, ignore or misapply: no
 * adapter-owned fields (`card_id`, `schema_version`, `kind`), no
 * `if`/`then`/`allOf`, no lookahead, no `maxLength`. The full schema still
 * judges the result.
 */
export function modelCardSchema() {
  const { signal, evidence, ask, choice, check_in } = cardSchema.properties;
  const { question, options } = ask.properties;
  const askShape = { type: 'object', description: ask.description, additionalProperties: false } as const;

  return withoutMaxLength({
    type: 'object',
    additionalProperties: false,
    required: ['signal', 'evidence', 'choice', 'check_in'],
    properties: {
      signal,
      evidence,
      ask: {
        anyOf: [
          { ...askShape, required: ['question', 'kind'], properties: { question, kind: { enum: ['text'] } } },
          { ...askShape, required: ['question', 'kind', 'options'], properties: { question, kind: { enum: ['chips'] }, options } },
        ],
      },
      choice,
      check_in: {
        ...check_in,
        properties: {
          ...check_in.properties,
          due_in: { type: 'string', pattern: MODEL_DUE_IN_PATTERN, description: 'ISO 8601 duration with one unit, e.g. P3D, P2W, PT12H.' },
        },
      },
    },
  } as const);
}
