// Ported from runtime/emissary/src/attribution.ts (trustvice-v3-2026-11-10-current),
// runtime/llmstxt/src/bots.ts (goplainly-v6-2026-11-10-current-dormant) and
// runtime/shared/web-bot-auth.ts (consentrack-v1-2026-10-30-fetch-ledger): one merged identity grade.
//
// TWO INDEPENDENT AXES, never blended:
//   grade    verified | failed | unauthenticated | unchecked
//            Decided ONLY by an RFC 9421 Web Bot Auth signature check.
//   network  none | claimed | ip-verified | rdns-verified
//            How far a User-Agent claim of a known agent is supported by the
//            source address (published CIDR list, or forward-confirmed rDNS).
//
// `verified` is NEVER derived from a User-Agent or an IP address. A spoofed
// `User-Agent: GPTBot` is `unauthenticated`, network `claimed`, operator null.
// Strong network evidence stays on the network axis: it can back a claim, it
// cannot make the request `verified`. The operator is non-null only when the
// grade is `verified`.

import { ipInAnyCidr } from "./cidr";
import { forwardConfirmedReverse, type DnsResolver } from "./rdns";
import { KNOWN_AGENTS, matchAgentByUserAgent, type KnownAgent } from "./registry";
import { fieldValue, type SignedMessage } from "./signatures";
import { verifyWebBotAuth, type IdentityGrade, type KeyResolver } from "./web-bot-auth";

export const NETWORK_EVIDENCE = ["none", "claimed", "ip-verified", "rdns-verified"] as const;
export type NetworkEvidence = (typeof NETWORK_EVIDENCE)[number];

/** Published CIDR ranges for an agent, or null when none are available (not checked). */
export type IpRangeProvider = (agent: KnownAgent) => Promise<readonly string[] | null>;

export type Identity = {
  readonly grade: IdentityGrade;
  readonly code: string;
  readonly reason: string;
  readonly network: NetworkEvidence;
  readonly networkNote: string;
  /** Registry id the User-Agent CLAIMS, whether or not anything supports it. */
  readonly claimedAgent: string | null;
  /** Attributable operator. NULL unless `grade` is `verified`. */
  readonly operator: string | null;
  readonly keyid: string | null;
  readonly signatureAgent: string | null;
  /** The signature verified for one registered operator while the User-Agent claimed another. */
  readonly contradiction: boolean;
};

export type GradeInput = {
  readonly message: SignedMessage;
  /** The source address, if the platform exposes it. Used for network evidence only. */
  readonly ip?: string | null;
  readonly now: Date;
};

export type GradeDeps = {
  readonly resolveKey?: KeyResolver;
  readonly ipRanges?: IpRangeProvider;
  readonly dns?: DnsResolver;
  readonly registry?: readonly KnownAgent[];
  readonly skewSeconds?: number;
  readonly maxValiditySeconds?: number;
};

async function networkEvidence(
  claimed: KnownAgent | null,
  ip: string | null | undefined,
  deps: GradeDeps,
): Promise<{ network: NetworkEvidence; note: string }> {
  if (!claimed) return { network: "none", note: "The User-Agent claims no known agent." };
  const claimNote = `The User-Agent claims ${claimed.token}; a User-Agent is typed by the client and proves nothing.`;
  if (!ip) return { network: "claimed", note: `${claimNote} No source address was supplied.` };

  const notes: string[] = [];
  if (claimed.ipRangesUrl && deps.ipRanges) {
    try {
      const ranges = await deps.ipRanges(claimed);
      if (ranges === null) notes.push("No published address ranges are available for this agent.");
      else if (ipInAnyCidr(ip, ranges)) {
        return { network: "ip-verified", note: `The source address is inside ${claimed.operator}'s published ranges for ${claimed.token}. This supports the claim; it is not a signature.` };
      } else notes.push("The source address is NOT inside the published ranges.");
    } catch {
      notes.push("The range provider failed, so the ranges were not checked.");
    }
  }
  if (claimed.rdnsSuffixes && deps.dns) {
    const r = await forwardConfirmedReverse(ip, claimed.rdnsSuffixes, deps.dns);
    if (r.forwardConfirmed) {
      return { network: "rdns-verified", note: `${r.note} This supports the claim; it is not a signature.` };
    }
    notes.push(r.note);
  }
  return { network: "claimed", note: [claimNote, ...notes].join(" ") };
}

/** Grade one request. Never throws, and never returns `verified` without a completed signature check. */
export async function gradeRequest(input: GradeInput, deps: GradeDeps = {}): Promise<Identity> {
  const registry = deps.registry ?? KNOWN_AGENTS;
  const claimed = matchAgentByUserAgent(fieldValue(input.message, "user-agent"), registry);

  const verdict = await verifyWebBotAuth(input.message, {
    now: input.now,
    resolveKey: deps.resolveKey ?? (async () => null),
    ...(deps.skewSeconds !== undefined ? { skewSeconds: deps.skewSeconds } : {}),
    ...(deps.maxValiditySeconds !== undefined ? { maxValiditySeconds: deps.maxValiditySeconds } : {}),
  });
  const net = await networkEvidence(claimed, input.ip, deps);

  const operator = verdict.grade === "verified" ? verdict.operator : null;
  const registryOperators = new Set(registry.map((a) => a.operator));
  const contradiction = operator !== null && claimed !== null && registryOperators.has(operator) && claimed.operator !== operator;

  return {
    grade: verdict.grade,
    code: verdict.code,
    reason: verdict.reason,
    network: net.network,
    networkNote: net.note,
    claimedAgent: claimed?.id ?? null,
    operator,
    keyid: verdict.keyid,
    signatureAgent: verdict.signatureAgent,
    contradiction,
  };
}
