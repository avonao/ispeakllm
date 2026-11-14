// Ported from runtime/shared/web-bot-auth.ts (consentrack-v1-2026-10-30-fetch-ledger)
//
// Web Bot Auth policy: turn one incoming request into one of four identity
// grades. RFC 9421 mechanics live in signatures.ts; this file decides which
// signatures count as a bot-identity claim, which key may answer for one, and
// what each outcome is allowed to be called.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. `failed` is an accusation: "a claim was
// made and did not stand up". It is durable and an operator will act on it, so
// it is reserved for the two cases where something was actually TESTED and came
// back negative:
//   - the signature base was built, the crypto ran, and it said no; or
//   - the claim's own validity window has passed (expired, or dated in the
//     future beyond the clock-skew tolerance).
// EVERYTHING else is `unchecked`, malformed signature headers included: we could
// not read the claim, so we have not disproven it. An unresolvable key, an
// algorithm we do not implement, a component parameter we refuse to guess at, a
// covered field the message no longer carries (a stripped header is at least as
// likely to be a proxy as a forger): all `unchecked`. `verified` is returned
// only after the signature check ran to completion against a resolved key.

import {
  isEd25519Jwk,
  parseSignatures,
  verifySignature,
  type Ed25519Jwk,
  type ParsedSignature,
  type SignedMessage,
  fieldValue,
} from "./signatures";
import { SfError, isInnerList, parseDictionary, parseItem } from "./structured-fields";

/** The four grades. Strongest first. Never derived from a User-Agent or an IP address alone. */
export const IDENTITY_GRADES = ["verified", "failed", "unauthenticated", "unchecked"] as const;
export type IdentityGrade = (typeof IDENTITY_GRADES)[number];

/** The draft requires this exact tag on a bot-identity signature. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth" as const;
/** Where a Web Bot Auth key directory lives under the Signature-Agent origin. */
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** At least one of these MUST be covered. */
const REQUIRED_COMPONENTS = ['"@authority"', '"@target-uri"'];

/** Where a key came from, which decides whether its `keyid` must be its thumbprint. */
export type KeySource = "directory" | "out-of-band";

export type ResolvedKey = { readonly jwk: unknown; readonly source: KeySource; readonly operator?: string | null };

/** Thrown by a resolver to say WHY it could not produce a key (becomes the verdict `code`). */
export class KeyResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KeyResolutionError";
  }
}

/**
 * Resolve `keyid` to a public key. Injected, never networked from inside this
 * module. `signatureAgent` is the directory origin the request asked us to use,
 * and is non-null ONLY when that header was itself covered by the signature.
 */
export type KeyResolver = (keyid: string, signatureAgent: string | null) => Promise<ResolvedKey | null>;

export type WebBotAuthVerdict = {
  readonly grade: IdentityGrade;
  /** Stable code for logs and tests. */
  readonly code: string;
  /** Why, in words. */
  readonly reason: string;
  readonly keyid: string | null;
  /** The operator this fetch may be attributed to. NULL unless `grade` is `verified`. */
  readonly operator: string | null;
  /** The directory origin, ONLY when the Signature-Agent header was signed. */
  readonly signatureAgent: string | null;
  readonly label: string | null;
};

export type VerifyOptions = {
  readonly now: Date;
  readonly resolveKey: KeyResolver;
  /** Tolerance for clock skew between us and the signer. Default 60. */
  readonly skewSeconds?: number;
  /** Reject a validity window longer than this. The draft recommends 24h. */
  readonly maxValiditySeconds?: number;
};

const DEFAULT_SKEW_SECONDS = 60;

/**
 * The directory origin a request nominates, but ONLY when the signature covers
 * it. An uncovered `Signature-Agent` is attacker-controlled: anyone can add the
 * header in flight, and trusting it would let a forger nominate the directory
 * that vouches for them. Handles both the string form (`"https://chatgpt.com"`)
 * and the dictionary form (`sig1="https://..."`). https only.
 */
export function coveredSignatureAgent(message: SignedMessage, parsed: ParsedSignature): string | null {
  const covered = parsed.covered.members.find((m) => m.value.type === "string" && m.value.value === "signature-agent");
  if (!covered) return null;
  const raw = fieldValue(message, "signature-agent");
  if (!raw) return null;

  let candidate: string | null = null;
  const keyParam = covered.params.find(([k]) => k === "key")?.[1];
  try {
    if (raw.trimStart().startsWith('"')) {
      const item = parseItem(raw);
      if (item.value.type === "string") candidate = item.value.value;
    } else {
      const dict = parseDictionary(raw);
      const member = keyParam && keyParam.type === "string" ? dict.find((m) => m.key === keyParam.value) : dict.length === 1 ? dict[0] : undefined;
      if (member && !isInnerList(member.value) && member.value.value.type === "string") candidate = member.value.value.value;
    }
  } catch (e) {
    if (!(e instanceof SfError)) throw e;
    return null;
  }
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    // A directory reached over plaintext cannot bind an identity.
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The base64url SHA-256 JWK thumbprint of an Ed25519 public key (RFC 7638 as
 * profiled by RFC 8037 Appendix A.3): exactly three members, lexicographically
 * ordered, no whitespace. Extra members (`kid`, `use`, `nbf`) are excluded by
 * construction, so a directory cannot change a thumbprint by decorating a key.
 */
export async function ed25519Thumbprint(jwk: { readonly crv: string; readonly kty: string; readonly x: string }): Promise<string> {
  const json = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const verdict = (v: WebBotAuthVerdict): WebBotAuthVerdict => v;
const NONE = { keyid: null, operator: null, signatureAgent: null, label: null } as const;

/**
 * Decide the identity grade of one incoming request. Never throws, and never
 * returns `verified` on a path that did not run the check to completion.
 */
export async function verifyWebBotAuth(message: SignedMessage, options: VerifyOptions): Promise<WebBotAuthVerdict> {
  const skew = options.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const nowSeconds = Math.floor(options.now.getTime() / 1000);

  const parsed = parseSignatures(message);
  if (!parsed.ok) {
    return verdict({ ...NONE, grade: "unchecked", code: parsed.error.code, reason: parsed.error.detail });
  }
  if (parsed.value.length === 0) {
    return verdict({
      ...NONE,
      grade: "unauthenticated",
      code: "unsigned",
      reason: "The request carried no HTTP message signature. Most clients do not sign; this is not an accusation.",
    });
  }

  const claims = parsed.value.filter((s) => s.params.tag === WEB_BOT_AUTH_TAG);
  if (claims.length === 0) {
    // Signed, but not making a bot-identity claim: `unauthenticated` would be
    // false (a signature WAS offered) and `failed` would accuse a signer of
    // failing a test it never took.
    return verdict({
      ...NONE,
      grade: "unchecked",
      code: "not_web_bot_auth",
      reason: `The request is signed, but no signature carries tag="${WEB_BOT_AUTH_TAG}", so it makes no bot-identity claim.`,
      label: parsed.value[0]?.label ?? null,
    });
  }

  // More than one bot-auth signature is legal; the first that verifies wins.
  let last: WebBotAuthVerdict | null = null;
  for (const claim of claims) {
    const v = await verifyOneClaim(message, claim, options, nowSeconds, skew);
    if (v.grade === "verified") return v;
    last = last && last.grade === "failed" ? last : v;
  }
  return last as WebBotAuthVerdict;
}

async function verifyOneClaim(
  message: SignedMessage,
  claim: ParsedSignature,
  options: VerifyOptions,
  nowSeconds: number,
  skew: number,
): Promise<WebBotAuthVerdict> {
  const signatureAgent = coveredSignatureAgent(message, claim);
  const base = { keyid: claim.params.keyid, operator: null, signatureAgent, label: claim.label } as const;
  const unchecked = (code: string, reason: string): WebBotAuthVerdict => verdict({ ...base, grade: "unchecked", code, reason });

  const coveredIds = claim.covered.members.filter((m) => m.value.type === "string").map((m) => `"${(m.value as { value: string }).value}"`);
  if (!REQUIRED_COMPONENTS.some((c) => coveredIds.includes(c))) {
    return unchecked("no_bound_component", "The signature covers neither @authority nor @target-uri, so it is not bound to this request and cannot identify its sender.");
  }
  if (claim.params.created === null || claim.params.expires === null) {
    return unchecked("no_validity_window", "Web Bot Auth requires both created and expires; without them the claim has no validity window to check.");
  }
  if (claim.params.created > nowSeconds + skew) {
    return verdict({ ...base, grade: "failed", code: "created_in_future", reason: `The signature claims to have been created at ${claim.params.created}, which is in the future.` });
  }
  if (claim.params.expires < nowSeconds - skew) {
    return verdict({ ...base, grade: "failed", code: "expired", reason: `The signature expired at ${claim.params.expires}; it is no longer a live claim.` });
  }
  const maxValidity = options.maxValiditySeconds;
  if (maxValidity !== undefined && claim.params.expires - claim.params.created > maxValidity) {
    return unchecked("validity_window_too_long", `The signature is valid for ${claim.params.expires - claim.params.created}s, beyond this origin's limit of ${maxValidity}s.`);
  }
  if (claim.params.alg !== null && claim.params.alg !== "ed25519") {
    return unchecked("unsupported_algorithm", `The signature declares alg="${claim.params.alg}"; only ed25519 is implemented.`);
  }
  if (!claim.params.keyid) {
    return unchecked("no_keyid", "The signature carries no keyid, so no key can be resolved to check it against.");
  }

  let resolved: ResolvedKey | null;
  try {
    resolved = await options.resolveKey(claim.params.keyid, signatureAgent);
  } catch (e) {
    if (e instanceof KeyResolutionError) return unchecked(e.code, e.message);
    return unchecked("resolver_unavailable", `The key directory could not be reached: ${(e as Error).message}`);
  }
  if (!resolved) {
    return unchecked("unknown_key", `No key is known for keyid ${claim.params.keyid}. Not a failure: an unknown signer is not a bad one.`);
  }
  if (!isEd25519Jwk(resolved.jwk)) {
    return unchecked("unusable_key", "The resolved key is not an Ed25519 public JWK, which is the only key type this verifier implements.");
  }
  const jwk: Ed25519Jwk = resolved.jwk;

  if (resolved.source === "directory") {
    const thumb = await ed25519Thumbprint(jwk);
    if (thumb !== claim.params.keyid) {
      // The directory served this key under an id that is not its thumbprint.
      // The signer is not at fault, so this is not `failed`.
      return unchecked("keyid_thumbprint_mismatch", `The directory returned a key whose thumbprint is ${thumb}, not the requested keyid.`);
    }
  }

  const result = await verifySignature(message, claim, jwk);
  if (!result.ok) {
    // The base could not be built, so the crypto never ran. Nothing was tested.
    return unchecked(result.error.code, result.error.detail);
  }
  if (!result.value) {
    return verdict({ ...base, grade: "failed", code: "bad_signature", reason: "The signature did not verify against the resolved key. A claim was made and did not stand up." });
  }
  return verdict({
    ...base,
    grade: "verified",
    operator: resolved.operator ?? (signatureAgent ? new URL(signatureAgent).host : null),
    code: "verified",
    reason: `The signature verified against key ${claim.params.keyid}.`,
  });
}
