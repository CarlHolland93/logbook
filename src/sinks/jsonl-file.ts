import { appendFile } from 'node:fs/promises';
import type { LogRecord, Sink } from '../types';

/** Node only. Appends one snapshot per line; the last line per record_id is current. */
export class JsonlFileSink implements Sink {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(record: LogRecord): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
