/** SHA-256 (WebCrypto), hex-encoded. Works in Node 20+, Workers, Deno, Bun and browsers. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Token estimate: ceil(UTF-8 bytes / 4). A deliberately simple, tokenizer-free
 * heuristic (about 4 bytes per token for English prose in common BPE
 * vocabularies). It is stable across runtimes and good enough for budgets and
 * the `x-markdown-tokens` header; it is NOT an exact count for any model.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}
