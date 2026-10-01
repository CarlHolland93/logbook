// Headless primitives. Each renders plain HTML with data-* attributes and no
// styling; skin/default.css targets those attributes. The seven rendering rules
// (SPEC §5.3) live here, not in the skin, so a skin can restyle them but not
// remove them.
import { useId, useState, type FormEvent } from 'react';
import { canExplain, CANT_TELL } from '../loop';
import type { Basis, DecisionCard, Option } from '../types';
import { CONFIDENCE_BANDS } from '../validate';
import type { LoopHandle } from './useLoop';

type Props = { loop: LoopHandle };

function decisionCard(loop: LoopHandle): DecisionCard | null {
  return loop.state !== 'composing' && loop.card?.kind === 'decision' ? loop.card : null;
}

const percent = (value: number) => Math.round(value * 100);

// ── 1 Signal ─────────────────────────────────────────────────────────────────

const LEVEL_TEXT = { low: 'Low', medium: 'Medium', high: 'High' } as const;

/** Rule 3: confidence renders as the level's band. The raw number stays in the log. */
export function Signal({ loop }: Props) {
  const card = decisionCard(loop);
  if (!card) return null;
  const { headline, level } = card.signal;
  const [lo, hi] = CONFIDENCE_BANDS[level];

  return (
    <section data-logbook="signal" data-level={level}>
      <h2 data-part="headline">{headline}</h2>
      <div data-part="confidence">
        <span data-part="band" role="img" aria-label={`Confidence ${LEVEL_TEXT[level].toLowerCase()}: somewhere from ${percent(lo)} to ${percent(hi)} percent`}>
          <span data-part="band-solid" />
          <span data-part="band-range" />
        </span>
        <span data-part="level" aria-hidden="true">
          {LEVEL_TEXT[level]} confidence
        </span>
      </div>
    </section>
  );
}

// ── 2 Evidence ───────────────────────────────────────────────────────────────

export const BASIS_TEXT: Readonly<Record<Basis, string>> = {
  data: 'Data',
  rule_of_thumb: 'Rule of thumb',
  you: 'You said',
  unknown: 'Unknown',
};

/** Rule 4: every line shows its basis as visible text, never a tooltip. */
export function Evidence({ loop }: Props) {
  const card = decisionCard(loop);
  if (!card) return null;

  return (
    <section data-logbook="evidence">
      <h3 data-part="title">What this is based on</h3>
      <ul>
        {card.evidence.map((line, i) => (
          <li key={i} data-basis={line.basis} {...(line.ref ? { 'data-ref': line.ref } : {})}>
            <span data-part="basis">{BASIS_TEXT[line.basis]}</span>
            <span data-part="text">{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── 3 Ask ────────────────────────────────────────────────────────────────────

type AskFormProps = {
  question: string;
  kind: 'text' | 'chips';
  options?: Option[];
  hint?: string;
  disabled: boolean;
  onAnswer: (answer: { kind: 'text'; text: string } | { kind: 'chips'; option_id: string }) => void;
  onSkip: () => void;
  purpose: 'ask' | 'override-reason';
};

/** The Ask primitive's body. Used for the card's own question and, per rule 5, for the override reason. */
function AskForm({ question, kind, options, hint, disabled, onAnswer, onSkip, purpose }: AskFormProps) {
  const id = useId();
  const [text, setText] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) onAnswer({ kind: 'text', text });
  };

  return (
    <section data-logbook="ask" data-purpose={purpose}>
      {kind === 'chips' ? (
        <div role="group" aria-labelledby={`${id}-q`}>
          <p id={`${id}-q`} data-part="question">
            {question}
          </p>
          <div data-part="chips">
            {options?.map((option) => (
              <button key={option.id} type="button" data-option={option.id} disabled={disabled} onClick={() => onAnswer({ kind: 'chips', option_id: option.id })}>
                {option.label}
              </button>
            ))}
            <button type="button" data-part="skip" disabled={disabled} onClick={onSkip}>
              Skip
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor={id} data-part="question">
            {question}
          </label>
          {hint && <p data-part="hint">{hint}</p>}
          <textarea id={id} rows={2} maxLength={500} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled} />
          <div data-part="actions">
            <button type="submit" disabled={disabled || !text.trim()}>
              Send
            </button>
            <button type="button" data-part="skip" disabled={disabled} onClick={onSkip}>
              Skip
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The card's own question, while there is still time to answer it before choosing. */
export function Ask({ loop }: Props) {
  const card = decisionCard(loop);
  if (!card?.ask || loop.state !== 'shown') return null;
  const { question, kind, options } = card.ask;

  return (
    <AskForm
      purpose="ask"
      question={question}
      kind={kind}
      options={options}
      disabled={loop.pending}
      onAnswer={(answer) => void loop.answer(answer)}
      onSkip={() => void loop.answer({ kind: 'skipped' })}
    />
  );
}

/**
 * Rule 5: after an override, the Ask primitive asks why. The choice is already
 * logged, so this never blocks, and skipping writes nothing. Worded the same
 * with or without the highlight, so it never reveals a held-out recommendation.
 */
export function OverrideReason({ loop }: Props) {
  const card = decisionCard(loop);
  const [skipped, setSkipped] = useState(false);
  if (!card || !loop.record || skipped || !canExplain(loop.record)) return null;
  const chosen = card.choice.options.find((o) => o.id === loop.record!.chose!.option_id)!;

  return (
    <AskForm
      purpose="override-reason"
      question={`What made you choose “${chosen.label}”?`}
      hint="Optional. Your choice is already saved."
      kind="text"
      disabled={loop.pending}
      onAnswer={(answer) => answer.kind === 'text' && void loop.explain(answer.text)}
      onSkip={() => setSkipped(true)}
    />
  );
}

// ── 4 Choice ─────────────────────────────────────────────────────────────────

/**
 * Rule 1: every option is one tap, with no confirm step.
 * Rule 2: the highlight comes from the record, which applied the holdout,
 * never from the card's own recommendation.
 */
export function Choice({ loop }: Props) {
  const card = decisionCard(loop);
  if (!card || !loop.record) return null;
  const highlighted = loop.record.shown.highlight_shown ? card.choice.recommended : null;
  const chosenId = loop.record.chose?.option_id;
  const open = loop.state === 'shown' || loop.state === 'answered';

  return (
    <section data-logbook="choice">
      <h3 data-part="title">What do you want to do?</h3>
      <div data-part="options" role="group" aria-label="Options">
        {card.choice.options.map((option) => (
          <button
            key={option.id}
            type="button"
            data-option={option.id}
            {...(option.id === highlighted ? { 'data-highlighted': '' } : {})}
            {...(option.id === chosenId ? { 'data-chosen': '' } : {})}
            aria-pressed={chosenId === undefined ? undefined : option.id === chosenId}
            disabled={!open || loop.pending}
            onClick={() => void loop.choose(option.id)}
          >
            <span data-part="label">{option.label}</span>
            {option.id === highlighted && <span data-part="recommended">Recommended</span>}
            {option.rationale && <span data-part="rationale">{option.rationale}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

// ── 5 Check-in ───────────────────────────────────────────────────────────────

/** Rule 6: "Can't tell" is always offered. Forced yes/no makes confident wrong labels. */
export function withCantTell(options: readonly Option[]): Option[] {
  return options.some((o) => o.id === CANT_TELL) ? [...options] : [...options, { id: CANT_TELL, label: 'Can’t tell' }];
}

/** The follow-up. The host decides when it is delivered; this renders it once it is. */
export function CheckIn({ loop }: Props) {
  const card = decisionCard(loop);
  if (!card || loop.state !== 'outcome_pending') return null;

  return (
    <section data-logbook="check-in">
      <h3 data-part="question">{card.check_in.question}</h3>
      <div data-part="options" role="group" aria-label="Answers">
        {withCantTell(card.check_in.options).map((option) => (
          <button
            key={option.id}
            type="button"
            data-option={option.id}
            disabled={loop.pending}
            onClick={() => void loop.outcome({ source: 'self', option_id: option.id })}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ── Prose fallback ───────────────────────────────────────────────────────────

/** Rule 7: the fallback says it is one. Plain text, no primitives. */
export function Prose({ loop }: Props) {
  const card = loop.state === 'composing' ? null : loop.card;
  if (card?.kind !== 'prose') return null;

  return (
    <section data-logbook="prose" {...(card.prose.reason ? { 'data-reason': card.prose.reason } : {})}>
      <p data-part="note">Couldn’t build the card. Here is the model’s answer as plain text.</p>
      <p data-part="text">{card.prose.text}</p>
      {(loop.state === 'shown' || loop.state === 'answered') && (
        <button type="button" disabled={loop.pending} onClick={() => void loop.abandon()}>
          Dismiss
        </button>
      )}
    </section>
  );
}
