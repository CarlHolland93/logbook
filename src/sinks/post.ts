import type { LogRecord, Sink } from '../types';

// Browsers refuse a keepalive request whose body is over 64 KiB. Records carry
// the full prompt, so a large one goes without keepalive rather than not at all.
const KEEPALIVE_MAX_BYTES = 60_000;

export type PostSinkOptions = { headers?: Record<string, string>; fetch?: typeof fetch };

/**
 * Browser sink: POSTs each snapshot as JSON to a record server. keepalive lets
 * the last snapshot (often an abandon on page close) outlive the page.
 */
export class PostSink implements Sink {
  readonly url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(url: string, options: PostSinkOptions = {}) {
    this.url = url;
    this.#headers = { 'content-type': 'application/json', ...options.headers };
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  async append(record: LogRecord): Promise<void> {
    const body = JSON.stringify(record);
    const response = await this.#fetch(this.url, {
      method: 'POST',
      headers: this.#headers,
      body,
      keepalive: new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    if (!response.ok) throw new Error(`The record server answered HTTP ${response.status}`);
  }
}
