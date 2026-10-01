import { createOpenAICompatibleAdapter } from '../../src/adapters/openai-compatible';
import { PostSink } from '../../src/sinks/post';
import type { Hypothesis, LogRecord } from '../../src/types';
import type { Backend } from '../shared/backend';

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
}

/** The local example: records, check-ins and the model all go through server.ts. */
export async function httpBackend(): Promise<Backend> {
  const config = (await (await fetch('/config')).json()) as { model: string; demo: boolean; hypothesis: Hypothesis; offsetMs: number };
  let offsetMs = config.offsetMs;

  return {
    config: {
      title: 'Open Sourced Learning',
      modelLabel: config.model,
      demo: config.demo,
      hypothesis: config.hypothesis,
      autoStart: false,
      editableFacts: true,
      note: `The card is written by ${config.model}, which takes about half a minute. Records go to ${config.demo ? 'records.demo.jsonl' : 'records.jsonl'}.`,
    },
    adapter: createOpenAICompatibleAdapter({ baseUrl: `${location.origin}/v1`, model: config.model }),
    sink: new PostSink('/records'),
    offsetMs: () => offsetMs,
    async snapshot() {
      try {
        const [due, clock] = await Promise.all(['/check-ins', '/clock'].map(async (path) => (await fetch(path)).json()));
        offsetMs = (clock as { offsetMs: number }).offsetMs;
        return { due: due as LogRecord[], offsetMs };
      } catch {
        throw new Error('Lost contact with the example server. Is it still running?');
      }
    },
    closeCheckIn: (recordId, optionId) => postJson(`/check-ins/${encodeURIComponent(recordId)}`, { option_id: optionId }),
    async advanceClock(ms) {
      await postJson('/clock/advance', { ms });
    },
  };
}
