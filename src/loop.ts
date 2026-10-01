import { addDuration } from './duration';
import { contextHash } from './hash';
import { checkRecord } from './validate';
import type {
  Adapter,
  Answer,
  Card,
  ComposeResult,
  DecisionCard,
  Hypothesis,
  LogRecord,
  Message,
  OutcomeResult,
  Sink,
  Status,
  Warning,
} from './types';

/** Appended by the UI to every check-in (SPEC §5.3 rule 6). Always a valid outcome. */
export const CANT_TELL = 'cant_tell';

const TEXT_MAX = 500;

// ── Pure transitions ─────────────────────────────────────────────────────────
// Each takes a record and returns the next snapshot. No I/O, no clock: callers
// pass `at`. The scheduler (step 6) uses these directly on records from the log.

function expectStatus(record: LogRecord, allowed: readonly Status[], action: string): void {
  if (!allowed.includes(record.status)) {
    throw new Error(`Cannot ${action} a record that is ${record.status}`);
  }
}

function decisionCard(record: LogRecord, action: string): DecisionCard {
  const { card } = record.shown;
  if (card.kind !== 'decision') throw new Error(`Cannot ${action} on a prose card`);
  return card;
}

function advance(record: LogRecord, status: Status, at: Date, patch: Partial<LogRecord> = {}): LogRecord {
  return { ...structuredClone(record), ...patch, status, updated_at: at.toISOString() };
}

export function answerRecord(record: LogRecord, answer: Answer, at: Date): LogRecord {
  expectStatus(record, ['shown'], 'answer');
  const { ask } = decisionCard(record, 'answer');
  if (!ask) throw new Error('This card has nothing to ask');

  if (answer.kind !== 'skipped' && answer.kind !== ask.kind) {
    throw new Error(`Expected a ${ask.kind} answer, got ${answer.kind}`);
  }
  if (answer.kind === 'chips' && !ask.options?.some((o) => o.id === answer.option_id)) {
    throw new Error(`"${answer.option_id}" is not one of the ask options`);
  }
  const stored = answer.kind === 'text' ? { ...answer, text: answer.text.slice(0, TEXT_MAX) } : answer;
  return advance(record, 'answered', at, { answered: { ...stored, at: at.toISOString() } });
}

/** The tap. Logged at once: the override reason, if any, arrives later through explainRecord. */
export function chooseRecord(record: LogRecord, optionId: string, at: Date): LogRecord {
  expectStatus(record, ['shown', 'answered'], 'choose on');
  const { choice } = decisionCard(record, 'choose');
  if (!choice.options.some((o) => o.id === optionId)) {
    throw new Error(`"${optionId}" is not one of the choice options`);
  }

  const recommended = choice.recommended;
  return advance(record, 'chosen', at, {
    chose: {
      option_id: optionId,
      recommended_id: recommended,
      agreed: recommended === null ? null : optionId === recommended,
      time_to_choose_ms: Math.max(0, at.getTime() - Date.parse(record.shown.at)),
      at: at.toISOString(),
    },
  });
}

/** Whether the person can still say why they overrode the recommendation (SPEC §5.3 rule 5). */
export function canExplain(record: LogRecord): boolean {
  return record.status === 'outcome_pending' && record.chose?.agreed === false && record.chose.override_reason === undefined;
}

/**
 * Adds the override reason after the choice is logged. The status stays
 * outcome_pending: this is an annotation, not a transition.
 */
export function explainRecord(record: LogRecord, reason: string, at: Date): LogRecord {
  if (!canExplain(record)) {
    throw new Error(
      record.chose?.agreed !== false
        ? 'Only an override can be explained'
        : record.status !== 'outcome_pending'
          ? `Cannot explain a record that is ${record.status}`
          : 'This override is already explained',
    );
  }
  const text = reason.trim().slice(0, TEXT_MAX);
  if (text === '') throw new Error('An override reason cannot be empty; to skip, do not call explain');
  return advance(record, 'outcome_pending', at, { chose: { ...record.chose!, override_reason: text } });
}

/** chosen → outcome_pending, immediately. Same timestamp as the choice. */
export function pendRecord(record: LogRecord): LogRecord {
  expectStatus(record, ['chosen'], 'schedule the check-in for');
  const card = decisionCard(record, 'schedule a check-in');
  const choseAt = new Date(record.chose!.at);
  return advance(record, 'outcome_pending', choseAt, {
    outcome: { due_at: addDuration(choseAt, card.check_in.due_in).toISOString() },
  });
}

export function closeRecord(record: LogRecord, result: OutcomeResult, at: Date): LogRecord {
  expectStatus(record, ['outcome_pending'], 'close');
  const card = decisionCard(record, 'close');
  const { option_id } = result;

  if (option_id !== undefined && option_id !== CANT_TELL && !card.check_in.options.some((o) => o.id === option_id)) {
    throw new Error(`"${option_id}" is not one of the check-in options`);
  }
  if (result.source === 'self' && option_id === undefined) {
    throw new Error('A self-reported outcome needs the check-in option the person picked');
  }
  if (result.source === 'system' && option_id === undefined && result.metric === undefined) {
    throw new Error('A system outcome needs an option_id or a metric');
  }
  return advance(record, 'closed', at, { outcome: { ...record.outcome!, ...result, at: at.toISOString() } });
}

/** When an unanswered check-in expires: due_at plus graceFactor × due_in (SPEC §12 default 2). */
export function expiresAt(record: LogRecord, graceFactor: number): Date {
  expectStatus(record, ['outcome_pending'], 'expire');
  const card = decisionCard(record, 'expire');
  return addDuration(new Date(record.outcome!.due_at), card.check_in.due_in, graceFactor);
}

export function expireRecord(record: LogRecord, at: Date, graceFactor: number): LogRecord {
  const deadline = expiresAt(record, graceFactor);
  if (at < deadline) throw new Error(`Check-in does not expire until ${deadline.toISOString()}`);
  return advance(record, 'expired', at, {
    outcome: { ...record.outcome!, source: 'none', at: at.toISOString() },
  });
}

export function abandonRecord(record: LogRecord, at: Date): LogRecord {
  expectStatus(record, ['shown', 'answered'], 'abandon');
  return advance(record, 'abandoned', at);
}

/** Which status may follow which in the log (SPEC §4). explain() is outcome_pending → outcome_pending. */
export const NEXT_STATUSES: Readonly<Record<Status, readonly Status[]>> = {
  shown: ['answered', 'chosen', 'abandoned'],
  answered: ['chosen', 'abandoned'],
  chosen: ['outcome_pending'],
  outcome_pending: ['outcome_pending', 'closed', 'expired'],
  closed: [],
  expired: [],
  abandoned: [],
};

/**
 * Why `next` cannot be the snapshot after `previous` for the same record, or
 * null if it can. A store uses this to refuse stale or doubled writes.
 */
export function followProblem(previous: LogRecord | undefined, next: LogRecord): string | null {
  if (!previous) return next.status === 'shown' ? null : `a new record must start as shown, not ${next.status}`;
  if (previous.record_id !== next.record_id) return 'record ids differ';
  if (previous.card_id !== next.card_id || previous.created_at !== next.created_at) return 'the card or creation time changed';
  if (!NEXT_STATUSES[previous.status].includes(next.status)) {
    return `a ${previous.status} record cannot become ${next.status}`;
  }
  if (previous.status === 'outcome_pending' && next.status === 'outcome_pending' && !canExplain(previous)) {
    return 'only an unexplained override can be annotated';
  }
  if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) return 'updated_at went backwards';
  return null;
}

// ── Stateful loop ────────────────────────────────────────────────────────────

export type LoopState = 'idle' | 'composing' | Status;

/** What a view reads. A new object on every change, so it can be compared by identity. */
export type LoopSnapshot = {
  readonly state: LoopState;
  readonly record: LogRecord | null;
  readonly card: Card | null;
  readonly warnings: readonly Warning[];
};

export type LoopOptions = {
  adapter: Adapter;
  sink: Sink;
  hypothesis: Hypothesis;
  /** Share of cards rendered without the highlight (SPEC §5.3 rule 2). */
  holdoutRate?: number;
  /** Expiry is due_at + graceFactor × due_in. */
  graceFactor?: number;
  actor?: LogRecord['actor'];
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
};

export type LoopComposeInput = {
  messages: Message[];
  /** Version of the prompt template that produced `messages`. */
  templateVersion: string;
  retrievalIds?: string[];
};

// A new record may start once the previous one no longer needs the person on screen.
const CAN_COMPOSE_FROM: readonly LoopState[] = ['idle', 'outcome_pending', 'closed', 'expired', 'abandoned'];

/**
 * One decision at a time. Owns the state machine and writes a full, validated
 * snapshot through the sink on every transition. The record and state only
 * move forward once the sink has accepted the snapshot.
 */
export class Loop {
  state: LoopState = 'idle';
  record: LogRecord | null = null;
  warnings: Warning[] = [];

  #snapshot: LoopSnapshot = { state: 'idle', record: null, card: null, warnings: [] };
  readonly #listeners = new Set<() => void>();
  // Transitions read the current record, await the sink, then advance. Two at
  // once would both read the same record and log contradictory snapshots.
  #busy = false;

  readonly #adapter: Adapter;
  readonly #sink: Sink;
  readonly #hypothesis: Hypothesis;
  readonly #holdoutRate: number;
  readonly #graceFactor: number;
  readonly #actor: LogRecord['actor'];
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #newId: () => string;

  constructor(options: LoopOptions) {
    this.#adapter = options.adapter;
    this.#sink = options.sink;
    this.#hypothesis = options.hypothesis;
    this.#holdoutRate = options.holdoutRate ?? 0.1;
    this.#graceFactor = options.graceFactor ?? 2;
    this.#actor = options.actor;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  get card(): Card | null {
    return this.record?.shown.card ?? null;
  }

  /** The current state as one immutable object. Stable until the next change. */
  get snapshot(): LoopSnapshot {
    return this.#snapshot;
  }

  /** Calls `listener` after every change. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads the loop's clock, so a view can tell whether a check-in is due. */
  now(): Date {
    return this.#now();
  }

  compose(input: LoopComposeInput): Promise<LogRecord> {
    return this.#exclusive(() => this.#compose(input));
  }

  async #compose(input: LoopComposeInput): Promise<LogRecord> {
    if (!CAN_COMPOSE_FROM.includes(this.state)) {
      throw new Error(`Cannot compose while ${this.state}; call abandon() first`);
    }
    const previous = this.state;
    this.#set('composing');
    try {
      const [result, hash] = await Promise.all([
        this.#adapter.compose({ messages: input.messages, hypothesis: this.#hypothesis, retrievalIds: input.retrievalIds }),
        contextHash(input.messages),
      ]);
      const record = this.#shownRecord(input, result, hash);
      await this.#write(record, result.warnings);
      return record;
    } catch (error) {
      this.#set(previous);
      throw error;
    }
  }

  answer(answer: Answer): Promise<LogRecord> {
    return this.#exclusive(() => this.#write(answerRecord(this.#current(), answer, this.#now())));
  }

  /** Writes two snapshots: chosen, then outcome_pending with the check-in's due_at. */
  choose(optionId: string): Promise<LogRecord> {
    return this.#exclusive(async () => {
      await this.#write(chooseRecord(this.#current(), optionId, this.#now()));
      return this.#write(pendRecord(this.#current()));
    });
  }

  /** Attaches the reason for an override. Optional: skipping means never calling it. */
  explain(reason: string): Promise<LogRecord> {
    return this.#exclusive(() => this.#write(explainRecord(this.#current(), reason, this.#now())));
  }

  outcome(result: OutcomeResult): Promise<LogRecord> {
    return this.#exclusive(() => this.#write(closeRecord(this.#current(), result, this.#now())));
  }

  /** For a scheduler: expires the record if its check-in is past due plus grace. */
  expireIfDue(): Promise<boolean> {
    return this.#exclusive(async () => {
      const record = this.#current();
      const now = this.#now();
      if (record.status !== 'outcome_pending' || now < expiresAt(record, this.#graceFactor)) return false;
      await this.#write(expireRecord(record, now, this.#graceFactor));
      return true;
    });
  }

  abandon(): Promise<LogRecord> {
    return this.#exclusive(() => this.#write(abandonRecord(this.#current(), this.#now())));
  }

  async #exclusive<T>(transition: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error('Another change to this record is still being saved');
    this.#busy = true;
    try {
      return await transition();
    } finally {
      this.#busy = false;
    }
  }

  #current(): LogRecord {
    if (!this.record || this.state === 'composing') throw new Error('No card is shown');
    return this.record;
  }

  #shownRecord(input: LoopComposeInput, result: ComposeResult, hash: string): LogRecord {
    const at = this.#now().toISOString();
    const { card } = result;
    const recommended = card.kind === 'decision' ? card.choice.recommended : null;
    const heldOut = this.#random() < this.#holdoutRate;

    return {
      schema_version: '0.1',
      record_id: this.#newId(),
      card_id: card.card_id,
      status: 'shown',
      created_at: at,
      updated_at: at,
      ...(this.#actor ? { actor: this.#actor } : {}),
      input: {
        messages: input.messages,
        template_version: input.templateVersion,
        card_schema_version: '0.1',
        sampling: result.sampling,
        ...(input.retrievalIds ? { retrieval_ids: input.retrievalIds } : {}),
        context_hash: hash,
        hypothesis: this.#hypothesis,
      },
      model: result.model,
      shown: {
        card,
        // Only true when there was something to highlight and this card is not in the holdout.
        highlight_shown: recommended !== null && !heldOut,
        ...(result.repair ? { repair: result.repair } : {}),
        latency_ms: result.latencyMs,
        at,
      },
    };
  }

  async #write(record: LogRecord, warnings?: Warning[]): Promise<LogRecord> {
    const problems = checkRecord(record);
    if (problems.length > 0) {
      throw new Error(`Refusing to log an invalid record: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    }
    await this.#sink.append(record);
    this.record = record;
    if (warnings) this.warnings = warnings;
    this.#set(record.status);
    return record;
  }

  #set(state: LoopState): void {
    this.state = state;
    this.#snapshot = { state, record: this.record, card: this.card, warnings: this.warnings };
    for (const listener of this.#listeners) listener();
  }
}
