import { closeRecord, expireRecord, expiresAt, followProblem } from '../../src/loop';
import type { LogRecord } from '../../src/types';
import { checkRecord } from '../../src/validate';

export type AppendResult = { ok: true; record: LogRecord } | { ok: false; status: 400 | 404 | 409; message: string };

const TAIL = 50;

/** Where accepted snapshots go: a JSONL file on the server, an array in the browser demo. */
export type Persist = (record: LogRecord) => Promise<void> | void;

/**
 * The record log's storage: an append-only log plus the latest snapshot per
 * record in memory. Every write is validated against the schema and against
 * the snapshot before it, so a stale or doubled write is refused rather than
 * logged. Writes are queued, so two for the same record can never both pass
 * against the same predecessor. Runs in Node and the browser.
 */
export class RecordStore {
  readonly #persist: Persist;
  readonly #latest = new Map<string, LogRecord>();
  readonly #tail: LogRecord[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  /** `existing` is the log so far, oldest first; it is trusted, having been validated when written. */
  constructor(persist: Persist, existing: Iterable<LogRecord> = []) {
    this.#persist = persist;
    for (const record of existing) this.#remember(record);
  }

  append(snapshot: unknown): Promise<AppendResult> {
    const result = this.#queue.then(() => this.#append(snapshot));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  get(recordId: string): LogRecord | undefined {
    return this.#latest.get(recordId);
  }

  /** Records waiting on a check-in. */
  pending(): LogRecord[] {
    return [...this.#latest.values()].filter((r) => r.status === 'outcome_pending');
  }

  /** Records whose check-in is due: the scheduler's delivery list. */
  due(now: Date): LogRecord[] {
    return this.pending().filter((r) => Date.parse(r.outcome!.due_at) <= now.getTime());
  }

  /** The last few snapshots written, newest last. */
  tail(count: number): LogRecord[] {
    return this.#tail.slice(-count);
  }

  /** Answers a check-in on the person's behalf, from the server's copy of the record. */
  close(recordId: string, optionId: string, now: Date): Promise<AppendResult> {
    const record = this.#latest.get(recordId);
    if (!record) return Promise.resolve({ ok: false, status: 404, message: `No record ${recordId}` });
    try {
      return this.append(closeRecord(record, { source: 'self', option_id: optionId }, now));
    } catch (error) {
      return Promise.resolve({ ok: false, status: 409, message: (error as Error).message });
    }
  }

  /** Expires every check-in past due plus grace. Returns how many. */
  async expireDue(now: Date, graceFactor: number): Promise<number> {
    let expired = 0;
    for (const record of this.pending()) {
      if (now < expiresAt(record, graceFactor)) continue;
      const result = await this.append(expireRecord(record, now, graceFactor));
      if (result.ok) expired++;
    }
    return expired;
  }

  async #append(snapshot: unknown): Promise<AppendResult> {
    const problems = checkRecord(snapshot);
    if (problems.length > 0) {
      return { ok: false, status: 400, message: problems.map((p) => `${p.path} ${p.message}`).join('; ') };
    }
    const record = snapshot as LogRecord;
    const problem = followProblem(this.#latest.get(record.record_id), record);
    if (problem) return { ok: false, status: 409, message: `Record ${record.record_id}: ${problem}` };

    await this.#persist(record);
    this.#remember(record);
    return { ok: true, record };
  }

  #remember(record: LogRecord): void {
    this.#latest.set(record.record_id, record);
    this.#tail.push(record);
    if (this.#tail.length > TAIL) this.#tail.shift();
  }
}
