// Hand-written mirrors of schema/card.schema.json and schema/record.schema.json.
// The schemas are the source of truth; the fixture tests keep these honest.

export type Option = { id: string; label: string };

export type Basis = 'data' | 'rule_of_thumb' | 'you' | 'unknown';

export type EvidenceLine = { text: string; basis: Basis; ref?: string };

export type DecisionCard = {
  schema_version: '0.1';
  card_id: string;
  kind: 'decision';
  signal: { headline: string; level: 'low' | 'medium' | 'high'; confidence: number };
  evidence: EvidenceLine[];
  ask?: { question: string; kind: 'text' | 'chips'; options?: Option[] };
  choice: { options: (Option & { rationale?: string })[]; recommended: string | null };
  check_in: { question: string; due_in: string; options: Option[]; confirms: string };
};

export type ProseReason = 'invalid_json' | 'schema_violation' | 'model_declined' | 'adapter_error';

export type ProseCard = {
  schema_version: '0.1';
  card_id: string;
  kind: 'prose';
  prose: { text: string; reason?: ProseReason };
};

export type Card = DecisionCard | ProseCard;

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export type Hypothesis = {
  context: string;
  who: string;
  what: string;
  what_changes: string;
  by_how_much: string;
};

export type Sampling = { temperature: number; top_p?: number; seed?: number; max_tokens?: number };

export type ModelInfo = {
  name: string;
  version?: string;
  provider: 'openai_compatible' | 'mock';
  endpoint_hash?: string;
};

/** A second turn that fixed, or tried to fix, a reply that failed validation. */
export type Repair = { problems: string[]; first_reply: string };

export type Status =
  | 'shown'
  | 'answered'
  | 'chosen'
  | 'outcome_pending'
  | 'closed'
  | 'expired'
  | 'abandoned';

export type Answer =
  | { kind: 'text'; text: string }
  | { kind: 'chips'; option_id: string }
  | { kind: 'skipped' };

export type OutcomeResult = {
  source: 'self' | 'system';
  option_id?: string;
  value_text?: string;
  metric?: { name: string; value: number; unit?: string };
};

export type LogRecord = {
  schema_version: '0.1';
  record_id: string;
  card_id: string;
  status: Status;
  created_at: string;
  updated_at: string;
  actor?: { user_hash?: string; role?: string; session_id?: string };
  input: {
    messages: Message[];
    template_version: string;
    card_schema_version: '0.1';
    sampling: Sampling;
    retrieval_ids?: string[];
    context_hash: string;
    hypothesis: Hypothesis;
  };
  model: ModelInfo;
  shown: {
    card: Card;
    highlight_shown: boolean;
    candidates?: Card[];
    shown_index?: number;
    repair?: Repair;
    latency_ms?: number;
    at: string;
  };
  answered?: Answer & { at: string };
  chose?: {
    option_id: string;
    recommended_id: string | null;
    agreed: boolean | null;
    override_reason?: string;
    time_to_choose_ms: number;
    evidence_expanded?: boolean;
    at: string;
  };
  outcome?: {
    source?: 'self' | 'system' | 'none';
    option_id?: string;
    value_text?: string;
    metric?: { name: string; value: number; unit?: string };
    due_at: string;
    at?: string;
  };
};

export type WarningCode = 'fabricated_ref' | 'you_without_ask' | 'confidence_out_of_band';

export type Warning = { code: WarningCode; path: string; message: string };

export type ComposeInput = {
  messages: Message[];
  hypothesis: Hypothesis;
  retrievalIds?: string[];
  candidates?: 1 | 2 | 3;
};

export type ComposeResult = {
  card: Card;
  candidates?: Card[];
  repair?: Repair;
  model: ModelInfo;
  sampling: Sampling;
  latencyMs: number;
  warnings: Warning[];
};

export type Adapter = {
  compose(input: ComposeInput): Promise<ComposeResult>;
};

export type Sink = {
  append(record: LogRecord): Promise<void> | void;
};
