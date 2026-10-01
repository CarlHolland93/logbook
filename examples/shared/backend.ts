import type { Adapter, Hypothesis, LogRecord, Sink } from '../../src/types';

export type BackendConfig = {
  /** The page heading. */
  title: string;
  /** What the header says is answering, e.g. "qwen2.5:7b". */
  modelLabel: string;
  /** Whether the clock can be moved forward. */
  demo: boolean;
  hypothesis: Hypothesis;
  /** Build the first situation's card on load, so a visitor lands on a card. Off where a card costs a model call. */
  autoStart: boolean;
  /** Let the facts be edited. Only useful where a real model reads them. */
  editableFacts: boolean;
  /** One line at the foot of the page, saying where this is running. */
  note?: string;
};

export type BackendSnapshot = { due: LogRecord[]; offsetMs: number };

/**
 * Everything the example app needs from outside the browser tab. The local
 * example talks to its server over HTTP; the hosted demo keeps it all in memory.
 */
export type Backend = {
  config: BackendConfig;
  adapter: Adapter;
  sink: Sink;
  /** How far the shared clock is ahead of real time. */
  offsetMs(): number;
  /** Due check-ins and the clock, polled by the app. */
  snapshot(): Promise<BackendSnapshot>;
  closeCheckIn(recordId: string, optionId: string): Promise<void>;
  advanceClock(ms: number): Promise<void>;
  /** The whole log as JSONL, where the viewer cannot open the file themselves. */
  download?(): string;
};
