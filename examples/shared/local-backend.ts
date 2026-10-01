import type { Adapter, LogRecord } from '../../src/types';
import type { Backend, BackendConfig } from './backend';
import { RecordStore } from './record-store';

export type LocalBackendOptions = {
  config: BackendConfig;
  adapter: Adapter;
  graceFactor?: number;
  /** How often expired check-ins are closed. */
  tickMs?: number;
};

/**
 * The whole example backend inside the browser tab, for the hosted demo: the
 * same record store and checks as the server, a log kept in memory, a clock
 * that can be moved forward, and the expiry timer.
 */
export function localBackend({ config, adapter, graceFactor = 2, tickMs = 1_000 }: LocalBackendOptions): Backend & { lines: LogRecord[]; stop(): void } {
  const lines: LogRecord[] = [];
  const store = new RecordStore((record) => void lines.push(record));
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const timer = setInterval(() => void store.expireDue(now(), graceFactor), tickMs);

  return {
    config,
    adapter,
    lines,
    sink: {
      async append(record) {
        const result = await store.append(record);
        if (!result.ok) throw new Error(result.message);
      },
    },
    offsetMs: () => offsetMs,
    snapshot: async () => ({ due: store.due(now()), offsetMs }),
    async closeCheckIn(recordId, optionId) {
      const result = await store.close(recordId, optionId, now());
      if (!result.ok) throw new Error(result.message);
    },
    async advanceClock(ms) {
      offsetMs += ms;
      await store.expireDue(now(), graceFactor);
    },
    download: () => lines.map((record) => JSON.stringify(record)).join('\n') + (lines.length ? '\n' : ''),
    stop: () => clearInterval(timer),
  };
}

