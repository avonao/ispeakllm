// Ported from runtime/emissary/src/reverse-dns.ts (trustvice-v3-2026-11-10-current)
//
// FORWARD-CONFIRMED reverse DNS. A PTR record is set by whoever controls the IP
// block, so on its own it is another self-assertion. The check that means
// something is the round trip: PTR gives a hostname, the hostname must sit under
// the operator's domain, and its A/AAAA records must resolve BACK to the address
// the request came from. Every failure mode returns a DISTINCT result: "our DNS
// call failed" must never look like "this party is not who it said it was".
//
// The resolver is an injected interface; this module never touches the network.
// `createDohResolver` adapts any `fetch` to it (the caller supplies the fetch).

import { normaliseIp, parseIp, toArpaName } from "./cidr";

/** Both methods resolve to the answer strings, `[]` for a valid empty answer, and REJECT when the lookup itself failed. */
export interface DnsResolver {
  /** PTR names for an address. */
  reverse(ip: string): Promise<readonly string[]>;
  /** A and AAAA addresses for a hostname. */
  forward(hostname: string): Promise<readonly string[]>;
}

export type ReverseDnsResult = {
  /** Whether a lookup was attempted. */
  readonly ran: boolean;
  /** The hostname that was forward-confirmed AND under an accepted suffix, else null. */
  readonly hostname: string | null;
  /** True ONLY when `hostname` forward-resolved back to the same address. */
  readonly forwardConfirmed: boolean;
  /** Plain-language outcome. */
  readonly note: string;
};

const MAX_PTR_NAMES = 5;

const underSuffix = (host: string, suffix: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = suffix.toLowerCase().replace(/^\./, "");
  return h === s || h.endsWith(`.${s}`);
};

/**
 * Forward-confirm `ip` against `suffixes` (the operator's reverse-DNS domains).
 * `hostname` is set (and `forwardConfirmed` true) only when a PTR name under
 * one of the suffixes resolves forward to the same address.
 */
export async function forwardConfirmedReverse(
  ip: string | null | undefined,
  suffixes: readonly string[],
  dns: DnsResolver,
): Promise<ReverseDnsResult> {
  if (!ip) return { ran: false, hostname: null, forwardConfirmed: false, note: "No address was supplied, so no reverse lookup was attempted." };
  const target = normaliseIp(ip);
  if (target === null || toArpaName(ip) === null) {
    return { ran: false, hostname: null, forwardConfirmed: false, note: "The address is not usable, so no reverse lookup was attempted." };
  }

  let ptr: readonly string[];
  try {
    ptr = await dns.reverse(ip);
  } catch {
    return { ran: true, hostname: null, forwardConfirmed: false, note: "The reverse lookup failed or timed out. This is a lookup fault, not a finding about the fetcher." };
  }
  if (ptr.length === 0) return { ran: true, hostname: null, forwardConfirmed: false, note: "The address has no PTR record, so no hostname was claimed." };

  const candidates = ptr.map((h) => h.replace(/\.$/, "")).slice(0, MAX_PTR_NAMES);
  const inScope = candidates.filter((h) => suffixes.some((s) => underSuffix(h, s)));
  if (inScope.length === 0) {
    return { ran: true, hostname: null, forwardConfirmed: false, note: `PTR returned ${candidates[0]}, which is not under an accepted domain. NOT confirmed.` };
  }

  let lookupFailed = false;
  for (const host of inScope) {
    let addrs: readonly string[];
    try {
      addrs = await dns.forward(host);
    } catch {
      lookupFailed = true;
      continue;
    }
    if (addrs.some((a) => normaliseIp(a) === target)) {
      return { ran: true, hostname: host, forwardConfirmed: true, note: `PTR returned ${host} and it forward-resolved back to the source address.` };
    }
  }
  return {
    ran: true,
    hostname: null,
    forwardConfirmed: false,
    note: lookupFailed
      ? `PTR returned ${inScope[0]}, but the forward lookup failed or timed out, so it is NOT confirmed.`
      : `PTR returned ${inScope[0]}, but its address records do not include the source address. NOT confirmed: a PTR is set by whoever controls the IP.`,
  };
}

/** Minimal fetch shape needed by the DoH adapter. */
export type DohFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * A DNS-over-HTTPS resolver (JSON API) over a caller-supplied fetch. No default
 * endpoint and no default fetch: the caller chooses the provider and owns the
 * network call.
 */
export function createDohResolver(opts: { fetch: DohFetch; endpoint: string; timeoutMs?: number }): DnsResolver {
  const timeoutMs = opts.timeoutMs ?? 800;
  async function query(name: string, type: "PTR" | "A" | "AAAA"): Promise<string[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await opts.fetch(`${opts.endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error("DoH request failed");
      const body = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
      if (body.Status === 3) return []; // NXDOMAIN is a real empty answer
      if (body.Status !== 0) throw new Error(`DoH status ${body.Status}`);
      const wanted = type === "PTR" ? 12 : type === "A" ? 1 : 28;
      return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    reverse: async (ip) => {
      const arpa = toArpaName(ip);
      if (!arpa) throw new Error("unusable address");
      return query(arpa, "PTR");
    },
    forward: async (hostname) => {
      const [a, aaaa] = await Promise.all([query(hostname, "A"), query(hostname, "AAAA")]);
      return [...a, ...aaaa];
    },
  };
}

export { parseIp };
