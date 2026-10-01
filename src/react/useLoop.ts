import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loop, type LoopComposeInput, type LoopOptions, type LoopSnapshot } from '../loop';
import type { Answer, LogRecord, OutcomeResult } from '../types';

export type LoopHandle = LoopSnapshot & {
  /** True while a transition is being written. Actions called meanwhile are ignored. */
  pending: boolean;
  /** The last action's error, cleared by the next action. */
  error: Error | null;
  /** Each action resolves to the new record, or undefined if it failed or was ignored. */
  compose(input: LoopComposeInput): Promise<LogRecord | undefined>;
  answer(answer: Answer): Promise<LogRecord | undefined>;
  choose(optionId: string): Promise<LogRecord | undefined>;
  explain(reason: string): Promise<LogRecord | undefined>;
  outcome(result: OutcomeResult): Promise<LogRecord | undefined>;
  abandon(): Promise<LogRecord | undefined>;
  now(): Date;
};

/**
 * One decision at a time, as React state. Takes loop options, or a Loop made
 * elsewhere (so a scheduler can share it). Options are read once, on mount.
 */
export function useLoop(options: LoopOptions | Loop): LoopHandle {
  const [loop] = useState(() => (options instanceof Loop ? options : new Loop(options)));
  const snapshot = useSyncExternalStore(loop.subscribe, () => loop.snapshot, () => loop.snapshot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // State updates land after a render; a ref stops a double tap in the same frame.
  const busy = useRef(false);

  const actions = useMemo(() => {
    function run<A extends unknown[]>(action: (...args: A) => Promise<LogRecord>) {
      return async (...args: A): Promise<LogRecord | undefined> => {
        if (busy.current) return undefined;
        busy.current = true;
        setPending(true);
        setError(null);
        try {
          return await action(...args);
        } catch (caught) {
          setError(caught instanceof Error ? caught : new Error(String(caught)));
          return undefined;
        } finally {
          busy.current = false;
          setPending(false);
        }
      };
    }
    return {
      compose: run((input: LoopComposeInput) => loop.compose(input)),
      answer: run((answer: Answer) => loop.answer(answer)),
      choose: run((optionId: string) => loop.choose(optionId)),
      explain: run((reason: string) => loop.explain(reason)),
      outcome: run((result: OutcomeResult) => loop.outcome(result)),
      abandon: run(() => loop.abandon()),
      now: () => loop.now(),
    };
  }, [loop]);

  return { ...snapshot, pending, error, ...actions };
}
