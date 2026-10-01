import { sha256Hex } from '../hash';
import { modelCardSchema } from '../model-schema';
import { repairMessage } from '../template';
import { buildCard, proseCard, type Problem } from '../validate';
import type { Adapter, ComposeInput, ComposeResult, Message, ModelInfo, Repair, Sampling } from '../types';

export type OpenAICompatibleOptions = {
  /** The endpoint's OpenAI-style root, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  sampling?: Partial<Sampling>;
  /**
   * `auto` probes the endpoint once. `json_schema` and `prompt_only` skip the
   * probe, for runtimes whose support is already known.
   */
  structuredOutput?: 'auto' | 'json_schema' | 'prompt_only';
  /**
   * When a reply fails validation, send the problems back once and use the
   * second reply. On by default: small models often miss a length limit and
   * fix it when told. The record keeps the first reply (shown.repair).
   */
  repair?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  newId?: () => string;
};

// The endpoint failed, as opposed to the model writing a bad card.
class EndpointError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

type Reply = { content: string; model?: string; fingerprint?: string };
type Runtime = { structured: boolean; version?: string };

const CARD_FORMAT = { type: 'json_schema', json_schema: { name: 'card', schema: modelCardSchema() } };

// An unconstrained model asked to say hello does not answer {"probe":"ok"}.
const PROBE_MESSAGES: Message[] = [{ role: 'user', content: 'Say hello.' }];
const PROBE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'probe',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['probe'],
      properties: { probe: { enum: ['ok'] } },
    },
  },
};

function isProbeReply(content: string): boolean {
  try {
    return (JSON.parse(content) as { probe?: unknown }).probe === 'ok';
  } catch {
    return false;
  }
}

/** Parses the reply, or the outermost {...} in it when the model wrapped its JSON in prose or a code fence. */
function parseReply(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return content;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return content;
    }
  }
}

// The value as JSON, so a number reads as a number and a string as a string.
const quote = (value: unknown) => {
  if (value === undefined) return '';
  const json = typeof value === 'string' && value.length > 80 ? JSON.stringify(`${value.slice(0, 80)}…`) : JSON.stringify(value);
  return ` (${json.length > 90 ? `${json.slice(0, 90)}…` : json})`;
};

/** Each problem as a line the model can act on: where, what it wrote there, and the rule. */
export function describeProblems(reply: unknown, problems: readonly Problem[]): string[] {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return ['The reply was not one JSON object.'];
  return problems.map(({ path, message }) => {
    if (path === '/') return message;
    const value = path.split('/').slice(1).reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], reply);
    return `${path}${quote(value)} ${message}`;
  });
}

/**
 * Chat completions against any OpenAI-compatible endpoint (Ollama, vLLM,
 * llama.cpp server, LM Studio). Never throws for a bad endpoint or a bad
 * reply: both come back as a prose card.
 */
export function createOpenAICompatibleAdapter(options: OpenAICompatibleOptions): Adapter {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? fetch;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const mode = options.structuredOutput ?? 'auto';
  const repairOn = options.repair ?? true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const sampling: Sampling = { temperature: 0.2, max_tokens: 800, ...options.sampling };
  const headers = {
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
  };

  async function chat(body: Record<string, unknown>): Promise<Reply> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: options.model, stream: false, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new EndpointError(timedOut ? 'it timed out' : 'no connection');
    }
    if (!response.ok) throw new EndpointError(`HTTP ${response.status}`, response.status);

    const json = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
      model?: string;
      system_fingerprint?: string;
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new EndpointError('an unexpected response');
    return { content, model: json?.model, fingerprint: json?.system_fingerprint };
  }

  // Tags are mutable, so where the runtime is Ollama, log the digest the tag points at.
  async function ollamaDigest(): Promise<string | undefined> {
    try {
      const response = await fetchFn(new URL('/api/tags', baseUrl), { headers, signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return undefined;
      const { models } = (await response.json()) as { models?: { name: string; digest: string }[] };
      const match = models?.find((m) => m.name === options.model || m.name === `${options.model}:latest`);
      return match ? `sha256:${match.digest}` : undefined;
    } catch {
      return undefined;
    }
  }

  // Runtimes that lack json_schema support mostly answer 200 and ignore it, so
  // the probe judges the reply, not the status.
  async function probe(): Promise<Runtime> {
    const version = await ollamaDigest();
    if (mode !== 'auto') return { structured: mode === 'json_schema', version };
    try {
      const reply = await chat({ messages: PROBE_MESSAGES, temperature: 0, max_tokens: 20, response_format: PROBE_FORMAT });
      return { structured: isProbeReply(reply.content), version };
    } catch (error) {
      const rejected = error instanceof EndpointError && (error.status === 400 || error.status === 422);
      if (rejected) return { structured: false, version };
      throw error;
    }
  }

  let runtime: Promise<Runtime> | undefined;
  let endpointHash: Promise<string> | undefined;

  return {
    async compose(input: ComposeInput): Promise<ComposeResult> {
      const started = performance.now();
      const cardId = newId();
      endpointHash ??= sha256Hex(baseUrl).then((hex) => hex.slice(0, 16));
      const model: ModelInfo = { name: options.model, provider: 'openai_compatible', endpoint_hash: await endpointHash };
      const result = ({ card, warnings, repair }: Pick<ComposeResult, 'card' | 'warnings' | 'repair'>): ComposeResult => ({
        card,
        warnings,
        ...(repair ? { repair } : {}),
        model,
        sampling,
        latencyMs: Math.round(performance.now() - started),
      });

      try {
        // Only a definite answer is kept: a failed probe is retried on the next card.
        runtime ??= probe().catch((error: unknown) => {
          runtime = undefined;
          throw error;
        });
        const { structured, version } = await runtime;
        const ask = (messages: Message[]) =>
          chat({ messages, ...sampling, ...(structured ? { response_format: CARD_FORMAT } : {}) });

        const reply = await ask(input.messages);
        if (reply.model) model.name = reply.model;
        const modelVersion = version ?? reply.fingerprint;
        if (modelVersion) model.version = modelVersion;

        const parsed = parseReply(reply.content);
        const first = buildCard(parsed, cardId, input.retrievalIds);
        if (first.card.kind !== 'prose' || !repairOn) return result(first);

        // One repair round. The conversation is the original prompt, the bad
        // reply, and what was wrong with it; the record keeps the bad reply.
        const repair: Repair = { problems: describeProblems(parsed, first.problems), first_reply: reply.content };
        const second = await ask([
          ...input.messages,
          { role: 'assistant', content: reply.content },
          { role: 'user', content: repairMessage(repair.problems) },
        ]);
        return result({ ...buildCard(parseReply(second.content), cardId, input.retrievalIds), repair });
      } catch (error) {
        if (!(error instanceof EndpointError)) throw error;
        const text = `The model could not be reached: ${error.message}.`;
        return result({ card: proseCard(cardId, text, 'adapter_error'), warnings: [] });
      }
    },
  };
}
