// Preference pairs from a records.jsonl.
//   pnpm pairs records.jsonl > pairs.jsonl
//
// Within-card pairs only: the option the person chose against each option they
// did not, on the same card. That is a ranking signal for a reranker, never a
// preference between two generations. A card-vs-card pair would need the person
// to have seen both cards, and the record holds no evidence of that (SPEC §8.1),
// so `--card-vs-card` refuses.
import { isMain, readLog, writeJsonl } from './cli';
import { materialise } from './materialise';
import type { LogRecord, Option } from '../src/types';

export type WithinCardPair = {
  kind: 'within_card';
  record_id: string;
  card_id: string;
  context_hash: string;
  template_version: string;
  chosen: Option;
  rejected: Option;
  recommended_id: string | null;
  highlight_shown: boolean;
  agreed: boolean | null;
  override_reason?: string;
  time_to_choose_ms: number;
  status: LogRecord['status'];
  /** The card came from a repair turn (shown.repair), so a training set can keep or drop it. */
  repaired: boolean;
  /** True when the check-in said the signal came true, false when it said not, undefined when unknown. */
  signal_confirmed?: boolean;
};

export const CARD_VS_CARD_REFUSAL =
  'Card-vs-card pairs are not emitted in v1: only one card is shown per decision, so the record holds no evidence that the person preferred it to another.';

/** What the check-in said about the signal, or undefined when it never closed with a yes/no answer. Only closing sets an option id. */
export function signalConfirmed(record: LogRecord): boolean | undefined {
  const { outcome } = record;
  const card = record.shown.card;
  if (card.kind !== 'decision' || !outcome?.option_id || outcome.option_id === 'cant_tell') return undefined;
  return outcome.option_id === card.check_in.confirms;
}

export function withinCardPairs(snapshots: Iterable<LogRecord>): WithinCardPair[] {
  const pairs: WithinCardPair[] = [];
  for (const record of materialise(snapshots)) {
    const { chose, shown } = record;
    if (!chose || shown.card.kind !== 'decision') continue;
    const options = shown.card.choice.options;
    const chosen = options.find((o) => o.id === chose.option_id)!;
    const confirmed = signalConfirmed(record);
    for (const rejected of options) {
      if (rejected.id === chosen.id) continue;
      pairs.push({
        kind: 'within_card',
        record_id: record.record_id,
        card_id: record.card_id,
        context_hash: record.input.context_hash,
        template_version: record.input.template_version,
        chosen: { id: chosen.id, label: chosen.label },
        rejected: { id: rejected.id, label: rejected.label },
        recommended_id: chose.recommended_id,
        highlight_shown: shown.highlight_shown,
        agreed: chose.agreed,
        ...(chose.override_reason ? { override_reason: chose.override_reason } : {}),
        time_to_choose_ms: chose.time_to_choose_ms,
        status: record.status,
        repaired: shown.repair !== undefined,
        ...(confirmed !== undefined ? { signal_confirmed: confirmed } : {}),
      });
    }
  }
  return pairs;
}

export function cardVsCardPairs(): never {
  throw new Error(CARD_VS_CARD_REFUSAL);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--card-vs-card')) {
    console.error(CARD_VS_CARD_REFUSAL);
    process.exit(1);
  }
  writeJsonl(withinCardPairs(readLog(args[0] ?? '-')));
}
