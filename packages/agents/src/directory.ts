// Ported from runtime/llmstxt/src/webbotauth.ts directory loading (goplainly-v6-2026-11-10-current-dormant)
// and the Signature-Agent rule of runtime/shared/web-bot-auth.ts (consentrack-v1-2026-10-30-fetch-ledger).
//
// Signature-Agent key-directory discovery, with bounds. A request that names a
// directory is asking US to fetch a URL, which makes this an SSRF-shaped
// surface, so every step is limited:
//   - the Signature-Agent header must be COVERED by the signature (enforced by
//     the verifier: an uncovered header never reaches the resolver);
//   - the origin must be on an allowlist (default: origins of registered agents);
//   - https only;
//   - the fetcher must NOT follow redirects (a redirect is refused);
//   - the body is capped in bytes;
//   - a per-origin refetch floor, so a flood of unknown keyids cannot make us
//     hammer a directory (and a failed fetch is remembered for the floor too).
// The fetch is an injected function: nothing here touches the network.

import { isEd25519Jwk, type Ed25519Jwk } from "./signatures";
import { DIRECTORY_PATH, KeyResolutionError, ed25519Thumbprint, type KeyResolver, type ResolvedKey } from "./web-bot-auth";
import { KNOWN_AGENTS, agentBySignatureOrigin, type KnownAgent } from "./registry";

export type DirectoryFetchResult = {
  readonly status: number;
  readonly body: Uint8Array;
  /** The fetcher stopped reading at the cap and there was more. */
  readonly truncated?: boolean;
  /** The fetcher saw a redirect. It must not have followed it. */
  readonly redirected?: boolean;
  readonly contentType?: string | null;
};

/** MUST use manual/error redirect handling and stop reading after `maxBytes`. Rejects on network failure or timeout. */
export type DirectoryFetcher = (url: string, limits: { readonly maxBytes: number; readonly timeoutMs: number }) => Promise<DirectoryFetchResult>;

export type DirectoryEntry = {
  readonly origin: string;
  /** ms since epoch of the fetch attempt. */
  readonly fetchedAt: number;
  /** Ed25519 keys with their thumbprints (empty when the attempt failed). */
  readonly keys: ReadonlyArray<{ readonly jwk: Ed25519Jwk; readonly thumbprint: string }>;
  /** Present when the attempt failed: the error to repeat inside the refetch floor. */
  readonly failure?: { readonly code: string; readonly message: string };
};

export interface DirectoryCache {
  get(origin: string): DirectoryEntry | undefined | Promise<DirectoryEntry | undefined>;
  set(origin: string, entry: DirectoryEntry): void | Promise<void>;
}

export class MemoryDirectoryCache implements DirectoryCache {
  private readonly m = new Map<string, DirectoryEntry>();
  get(origin: string): DirectoryEntry | undefined {
    return this.m.get(origin);
  }
  set(origin: string, entry: DirectoryEntry): void {
    this.m.set(origin, entry);
  }
}

export type DirectoryResolverOptions = {
  readonly fetcher: DirectoryFetcher;
  /** Origins we may fetch a directory from. Default: the Signature-Agent origins of the known-agent registry. */
  readonly allowedOrigins?: readonly string[] | ((origin: string) => boolean);
  readonly cache?: DirectoryCache;
  /** Epoch milliseconds. Injected so tests control time. */
  readonly now: () => number;
  /** Keys trusted out of band, by keyid. Checked first. */
  readonly outOfBandKeys?: Readonly<Record<string, { jwk: Ed25519Jwk; operator?: string | null }>>;
  readonly registry?: readonly KnownAgent[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Minimum gap between two fetches of the same origin. Default 60 s. */
  readonly refetchFloorSeconds?: number;
  /** How long a fetched directory is used before it is refetched (subject to the floor). Default 1 h. */
  readonly ttlSeconds?: number;
  readonly maxKeys?: number;
};

const ACCEPTED_TYPES = ["application/http-message-signatures-directory+json", "application/json"];

async function parseDirectory(body: Uint8Array, maxKeys: number): Promise<Array<{ jwk: Ed25519Jwk; thumbprint: string }>> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const json = JSON.parse(text) as { keys?: unknown };
  if (!json || !Array.isArray(json.keys)) throw new KeyResolutionError("directory_malformed", "The directory has no `keys` array.");
  const out: Array<{ jwk: Ed25519Jwk; thumbprint: string }> = [];
  for (const k of json.keys.slice(0, maxKeys)) {
    if (!isEd25519Jwk(k)) continue;
    const jwk: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: k.x };
    out.push({ jwk, thumbprint: await ed25519Thumbprint(jwk) });
  }
  return out;
}

/**
 * Build the key resolver the verifier calls. Failures throw
 * {@link KeyResolutionError} with a stable code, which the verifier records as
 * `unchecked` (never `failed`: an unreachable directory says nothing about the signer).
 */
export function createDirectoryKeyResolver(opts: DirectoryResolverOptions): KeyResolver {
  const cache = opts.cache ?? new MemoryDirectoryCache();
  const registry = opts.registry ?? KNOWN_AGENTS;
  const maxBytes = opts.maxBytes ?? 65_536;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const floorMs = (opts.refetchFloorSeconds ?? 60) * 1000;
  const ttlMs = Math.max((opts.ttlSeconds ?? 3600) * 1000, floorMs);
  const maxKeys = opts.maxKeys ?? 32;

  const allowed = (origin: string): boolean => {
    const a = opts.allowedOrigins;
    if (typeof a === "function") return a(origin);
    if (a) return a.includes(origin);
    return registry.some((r) => r.signatureAgentOrigins?.includes(origin));
  };

  const operatorFor = (origin: string): string => agentBySignatureOrigin(origin, registry)?.operator ?? new URL(origin).host;

  async function refresh(origin: string): Promise<DirectoryEntry> {
    const fetchedAt = opts.now();
    const fail = async (code: string, message: string): Promise<never> => {
      await cache.set(origin, { origin, fetchedAt, keys: [], failure: { code, message } });
      throw new KeyResolutionError(code, message);
    };
    let res: DirectoryFetchResult;
    try {
      res = await opts.fetcher(`${origin}${DIRECTORY_PATH}`, { maxBytes, timeoutMs });
    } catch (e) {
      return fail("directory_unreachable", `The key directory could not be fetched: ${(e as Error).message}`);
    }
    if (res.redirected || (res.status >= 300 && res.status < 400)) return fail("directory_redirect_refused", "The directory answered with a redirect, which is never followed.");
    if (res.status !== 200) return fail("directory_bad_status", `The directory answered with HTTP ${res.status}.`);
    if (res.truncated || res.body.byteLength > maxBytes) return fail("directory_too_large", `The directory exceeds the ${maxBytes}-byte cap.`);
    const ct = res.contentType?.split(";")[0]?.trim().toLowerCase();
    if (ct && !ACCEPTED_TYPES.includes(ct)) return fail("directory_bad_content_type", `The directory has content type ${ct}.`);
    let keys;
    try {
      keys = await parseDirectory(res.body, maxKeys);
    } catch (e) {
      if (e instanceof KeyResolutionError) return fail(e.code, e.message);
      return fail("directory_malformed", "The directory is not valid JSON.");
    }
    const entry: DirectoryEntry = { origin, fetchedAt, keys };
    await cache.set(origin, entry);
    return entry;
  }

  return async (keyid, signatureAgent): Promise<ResolvedKey | null> => {
    const oob = opts.outOfBandKeys?.[keyid];
    if (oob) return { jwk: oob.jwk, source: "out-of-band", operator: oob.operator ?? null };
    // The verifier passes a non-null origin only when the header was covered by the signature.
    if (signatureAgent === null) return null;
    let origin: string;
    try {
      const u = new URL(signatureAgent);
      if (u.protocol !== "https:") throw new Error("not https");
      origin = u.origin;
    } catch {
      throw new KeyResolutionError("directory_not_https", "The Signature-Agent is not an https origin.");
    }
    if (!allowed(origin)) {
      throw new KeyResolutionError("directory_origin_not_allowed", `${origin} is not an allowed key-directory origin.`);
    }

    const now = opts.now();
    let entry = await cache.get(origin);
    const canFetch = !entry || now - entry.fetchedAt >= floorMs;
    if (entry && !entry.failure) {
      const hit = entry.keys.find((k) => k.thumbprint === keyid);
      if (hit && (now - entry.fetchedAt < ttlMs || !canFetch)) return { jwk: hit.jwk, source: "directory", operator: operatorFor(origin) };
      if (!canFetch) return null; // unknown key, floor not elapsed: do not hammer the directory
    } else if (entry?.failure && !canFetch) {
      throw new KeyResolutionError(entry.failure.code, entry.failure.message);
    }
    entry = await refresh(origin);
    const hit = entry.keys.find((k) => k.thumbprint === keyid);
    return hit ? { jwk: hit.jwk, source: "directory", operator: operatorFor(origin) } : null;
  };
}
