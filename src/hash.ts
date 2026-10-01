import type { Message } from './types';

/** Uses Web Crypto so it runs in Node and the browser. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable hash of the prompt. */
export async function contextHash(messages: readonly Message[]): Promise<string> {
  return `sha256:${await sha256Hex(JSON.stringify(messages.map((m) => [m.role, m.content])))}`;
}
