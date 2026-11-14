// Ported from runtime/llmstxt/src/bots.ts (goplainly-v6-2026-11-10-current-dormant) and the KnownAgent
// registry of runtime/emissary/src/attribution.ts (trustvice-v3-2026-11-10-current).
//
// The known-agent registry: stable identities and the published ways to check
// them. A registry entry proves nothing by itself. A User-Agent that contains
// one of these tokens is a CLAIM; only a verified signature, or published
// network evidence, can support it. Range URLs are data for an adapter to fetch
// (cron); nothing here touches the network.

export type AgentKind = "training" | "search" | "user-fetch" | "crawler" | "opt-out-token";

export type KnownAgent = {
  /** Stable id used in logs and fetch records. */
  readonly id: string;
  /** The product token as it appears in User-Agent / robots.txt. */
  readonly token: string;
  readonly operator: string;
  readonly kind: AgentKind;
  /** Origins this operator signs from (Signature-Agent), https only. */
  readonly signatureAgentOrigins?: readonly string[];
  /** Published JSON list of CIDR ranges, for an injected range provider to fetch. */
  readonly ipRangesUrl?: string;
  /** Reverse-DNS suffixes a forward-confirmed hostname must end with. */
  readonly rdnsSuffixes?: readonly string[];
  readonly note?: string;
};

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: "gptbot", token: "GPTBot", operator: "OpenAI", kind: "training", ipRangesUrl: "https://openai.com/gptbot.json" },
  { id: "oai-searchbot", token: "OAI-SearchBot", operator: "OpenAI", kind: "search", ipRangesUrl: "https://openai.com/searchbot.json" },
  {
    id: "chatgpt-user",
    token: "ChatGPT-User",
    operator: "OpenAI",
    kind: "user-fetch",
    signatureAgentOrigins: ["https://chatgpt.com"],
    ipRangesUrl: "https://openai.com/chatgpt-user.json",
  },
  { id: "claudebot", token: "ClaudeBot", operator: "Anthropic", kind: "training", note: "No published IP list; verify by signature only." },
  { id: "claude-searchbot", token: "Claude-SearchBot", operator: "Anthropic", kind: "search", note: "No published IP list." },
  { id: "claude-user", token: "Claude-User", operator: "Anthropic", kind: "user-fetch", note: "No published IP list." },
  { id: "perplexitybot", token: "PerplexityBot", operator: "Perplexity", kind: "search", ipRangesUrl: "https://www.perplexity.com/perplexitybot.json" },
  { id: "perplexity-user", token: "Perplexity-User", operator: "Perplexity", kind: "user-fetch", ipRangesUrl: "https://www.perplexity.com/perplexity-user.json" },
  {
    id: "googlebot",
    token: "Googlebot",
    operator: "Google",
    kind: "crawler",
    ipRangesUrl: "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
    rdnsSuffixes: ["googlebot.com", "google.com"],
  },
  {
    id: "google-extended",
    token: "Google-Extended",
    operator: "Google",
    kind: "opt-out-token",
    note: "A robots.txt token, not a crawler: Google fetches under its normal crawler user agents, so a request naming it is only ever a claim.",
  },
  { id: "bingbot", token: "Bingbot", operator: "Microsoft", kind: "crawler", ipRangesUrl: "https://www.bing.com/toolbox/bingbot.json", rdnsSuffixes: ["search.msn.com"] },
  { id: "applebot", token: "Applebot", operator: "Apple", kind: "crawler", ipRangesUrl: "https://search.developer.apple.com/applebot.json", rdnsSuffixes: ["applebot.apple.com"] },
  { id: "ccbot", token: "CCBot", operator: "Common Crawl", kind: "training", ipRangesUrl: "https://index.commoncrawl.org/ccbot.json" },
  { id: "bytespider", token: "Bytespider", operator: "ByteDance", kind: "training", note: "No published verification method; always only claimed." },
];

/**
 * The registry entry a User-Agent CLAIMS to be: the longest case-insensitive
 * token contained in it, so a more specific token wins over a shorter one.
 */
export function matchAgentByUserAgent(ua: string | null | undefined, registry: readonly KnownAgent[] = KNOWN_AGENTS): KnownAgent | null {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  let best: KnownAgent | null = null;
  for (const a of registry) {
    if (lower.includes(a.token.toLowerCase()) && (!best || a.token.length > best.token.length)) best = a;
  }
  return best;
}

/** The registry entry whose Signature-Agent origin is `origin`. */
export function agentBySignatureOrigin(origin: string, registry: readonly KnownAgent[] = KNOWN_AGENTS): KnownAgent | null {
  return registry.find((a) => a.signatureAgentOrigins?.includes(origin)) ?? null;
}
