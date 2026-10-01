import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LogRecord } from '../src/types';

/** True when this module is the script being run, not an import. */
export function isMain(moduleUrl: string): boolean {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
}

/** Reads a records.jsonl file (or stdin for "-") into snapshots, in file order. */
export function readLog(path: string): LogRecord[] {
  const text = readFileSync(path === '-' ? 0 : path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogRecord);
}

export function writeJsonl(rows: readonly unknown[]): void {
  // `| head` closes the pipe early; that is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => process.exit(error.code === 'EPIPE' ? 0 : 1));
  process.stdout.write(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}
