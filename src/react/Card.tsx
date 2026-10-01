import { Ask, CheckIn, Choice, Evidence, OverrideReason, Prose, Signal } from './primitives';
import type { LoopHandle } from './useLoop';

export type CardProps = {
  loop: LoopHandle;
  /**
   * Whether the check-in has been delivered. Delivery belongs to the host (a
   * scheduler, a notification), not the card, so this defaults to false.
   */
  checkInOpen?: boolean;
  /**
   * Show the loop's status as a line on the card. Turn it off where the host
   * says it another way, such as a chat that replies with its own message.
   */
  status?: boolean;
};

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

function StatusLine({ loop, checkInOpen }: CardProps) {
  const { state, record, card } = loop;
  if (!record) return null;
  const text =
    state === 'outcome_pending' && !checkInOpen && card?.kind === 'decision'
      ? `Saved. We’ll ask “${card.check_in.question}” on ${DATE.format(new Date(record.outcome!.due_at))}.`
      : state === 'closed'
        ? 'Saved. Thanks for closing the loop.'
        : state === 'expired'
          ? 'The check-in closed without an answer.'
          : state === 'abandoned'
            ? 'Set aside without a decision.'
            : null;
  return text ? <p data-logbook="status">{text}</p> : null;
}

/** Composes the five primitives in their fixed order, plus the fallback and the loop's status. */
export function Card({ loop, checkInOpen = false, status = true }: CardProps) {
  const { state, record, error } = loop;
  // Keyed by record so a new decision starts with fresh drafts and no remembered skip.
  const key = record?.record_id ?? 'none';

  return (
    <article data-logbook="card" data-state={state} aria-busy={state === 'composing' || loop.pending}>
      {state === 'composing' && (
        <p data-logbook="composing" role="status">
          Building the card…
        </p>
      )}
      <Prose loop={loop} />
      <Signal loop={loop} />
      <Evidence loop={loop} />
      <Ask key={`ask-${key}`} loop={loop} />
      <Choice loop={loop} />
      <OverrideReason key={`reason-${key}`} loop={loop} />
      {checkInOpen && <CheckIn loop={loop} />}
      {status && <StatusLine loop={loop} checkInOpen={checkInOpen} />}
      {error && (
        <p data-logbook="error" role="alert">
          {error.message}
        </p>
      )}
    </article>
  );
}
