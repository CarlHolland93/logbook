// records.jsonl → the latest snapshot per record_id, in first-seen order.
//   pnpm materialise records.jsonl > latest.jsonl
import { isMain, readLog, writeJsonl } from './cli';
import type { LogRecord } from '../src/types';

export function materialise(snapshots: Iterable<LogRecord>): LogRecord[] {
  const latest = new Map<string, LogRecord>();
  for (const snapshot of snapshots) latest.set(snapshot.record_id, snapshot);
  return [...latest.values()];
}

if (isMain(import.meta.url)) writeJsonl(materialise(readLog(process.argv[2] ?? '-')));
