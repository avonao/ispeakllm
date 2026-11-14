// Ported from runtime/llmstxt/src/sign.ts (goplainly-v6-2026-11-10-current-dormant); verification logic also from verifier/src/gp-acm.ts
/**
 * Signed ACM manifests.
 *
 * Signing payload = JCS of the manifest with `provenance` MINUS `signature`, `anchor`
 * and `content_id` (every other provenance member is signed, so nothing unsigned can
 * ride along inside the envelope). The signature can therefore stay valid when an
 * anchor is added later.
 *
 * `provenance.content_id` = `ispk_` + base64url(SHA-256(JCS(payload))): the content
 * address. Verification recomputes it BEFORE checking the signature, so any change to
 * the payload (one byte, `deny` -> `allow`) is reported as a content-address mismatch.
 */

import { canonicalBytes } from "./jcs";
import { contentId, sha256Hex } from "./hash";
import { fromBase64Url } from "./encoding";
import { signBytes, verifyBytes, thumbprint, isEd25519Jwk, type Jwk, type PublicJwk } from "./keys";
import type { Jwks, JwksReader } from "./jwks";

export const ALGORITHM = "Ed25519" as const;
export const CANONICALIZATION = "JCS/RFC8785" as const;

export type Anchor = {
  attestation_id?: string;
  status?: "pending" | "settled";
  txid?: string;
  block_height?: number;
  merkle_proof_ref?: string;
  anchored_at?: string;
};

export type Provenance = {
  algorithm: typeof ALGORITHM;
  canonicalization: typeof CANONICALIZATION;
  signed_at: string;
  key_ref?: string;
  /** Raw Ed25519 public key (the JWK `x`), base64url. */
  public_key?: string;
  /** Content address of the signing payload. */
  content_id?: string;
  signature: string;
  anchor?: Anchor;
};

export type UnsignedManifest = Record<string, unknown> & { provenance?: never };
export type SignedManifest = Record<string, unknown> & { provenance: Provenance };

const EXCLUDED = new Set(["signature", "anchor", "content_id"]);

/** The exact object that is canonicalised, hashed and signed. */
export function signingPayload(manifest: Record<string, unknown> & { provenance: Record<string, unknown> }): Record<string, unknown> {
  const { provenance, ...rest } = manifest;
  const prov: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(provenance)) if (!EXCLUDED.has(k)) prov[k] = v;
  return { ...rest, provenance: prov };
}

export type SignOptions = {
  /** ISO-8601 timestamp (default: now). Pass it explicitly for reproducible output. */
  signedAt?: string;
  /** Key id to record (default: the key's `kid`, else its RFC 7638 thumbprint). */
  keyRef?: string;
  /** Embed the public key so the manifest verifies offline (default true). */
  embedPublicKey?: boolean;
};

/** Sign an unsigned manifest (e.g. from `buildAcmShell`) with an Ed25519 private JWK. */
export async function signManifest(shell: Record<string, unknown>, privateKey: Jwk, opts: SignOptions = {}): Promise<SignedManifest> {
  if ("provenance" in shell && shell.provenance !== undefined) throw new Error("@ispeakllm/sign: manifest already has a provenance block; pass the unsigned shell");
  if (!isEd25519Jwk(privateKey) || !privateKey.d) throw new Error("@ispeakllm/sign: signManifest needs a private Ed25519 JWK");
  const keyRef = opts.keyRef ?? privateKey.kid ?? (await thumbprint(privateKey));
  const provenance: Record<string, unknown> = {
    algorithm: ALGORITHM,
    canonicalization: CANONICALIZATION,
    signed_at: opts.signedAt ?? new Date().toISOString(),
    key_ref: keyRef,
  };
  if (opts.embedPublicKey !== false) provenance.public_key = privateKey.x;
  const payload = signingPayload({ ...shell, provenance });
  const id = await contentId(payload);
  const signature = await signBytes(privateKey, canonicalBytes(payload));
  return { ...shell, provenance: { ...provenance, content_id: id, signature } } as SignedManifest;
}

export type VerifyCode =
  | "ok"
  | "malformed"
  | "unsupported_envelope"
  | "no_public_key"
  | "key_mismatch"
  | "content_address_mismatch"
  | "signature_invalid";

export type VerifyDetails = {
  domain?: string;
  signedAt?: string;
  expiresAt?: string;
  /** True when `now` was supplied and `expires_at` is in the past. Informational: does not fail verification. */
  expired?: boolean;
  kid?: string;
  contentId?: string;
  /** SHA-256 hex of the canonical signing payload. */
  payloadDigest?: string;
  anchorStatus?: string;
  /** True when the key came from the caller (pinned) rather than the manifest. */
  pinnedKey?: boolean;
};

export type VerifyResult = { ok: boolean; code: VerifyCode; reason?: string; details: VerifyDetails };

export type VerifyOptions = {
  /** Pin the verification key (ignores the embedded `public_key`). */
  publicKey?: Jwk | PublicJwk;
  /** Pin keys by `provenance.key_ref` (a JWKS document or a reader from `readJwks`). */
  jwks?: Jwks | JwksReader;
  /** Refuse manifests without a `content_id` (signManifest always sets it). Default false. */
  requireContentId?: boolean;
  /** Current time (ISO string or Date) for the informational `expired` flag. */
  now?: string | Date;
};

const bad = (code: VerifyCode, reason: string, details: VerifyDetails = {}): VerifyResult => ({ ok: false, code, reason, details });

function lookup(jwks: Jwks | JwksReader, kid: string): PublicJwk | undefined {
  if (typeof (jwks as JwksReader).get === "function") return (jwks as JwksReader).get(kid);
  return (jwks as Jwks).keys.find((k) => k.kid === kid);
}

/**
 * Verify a signed manifest. Order: envelope shape, key resolution, content address
 * (payload tampering), then the Ed25519 signature.
 */
export async function verifyManifest(manifest: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return bad("malformed", "manifest must be a JSON object");
  const m = manifest as Record<string, unknown>;
  const prov = m.provenance as Record<string, unknown> | undefined;
  const details: VerifyDetails = {
    domain: typeof m.domain === "string" ? m.domain : undefined,
    expiresAt: typeof m.expires_at === "string" ? m.expires_at : undefined,
  };
  if (!prov || typeof prov !== "object") return bad("unsupported_envelope", "no provenance block (unsigned manifest)", details);
  if (prov.algorithm !== ALGORITHM || prov.canonicalization !== CANONICALIZATION) {
    return bad("unsupported_envelope", "unsupported provenance envelope (need Ed25519 + JCS/RFC8785)", details);
  }
  if (typeof prov.signature !== "string") return bad("malformed", "provenance.signature missing", details);
  details.signedAt = typeof prov.signed_at === "string" ? prov.signed_at : undefined;
  details.kid = typeof prov.key_ref === "string" ? prov.key_ref : undefined;
  details.anchorStatus = (prov.anchor as { status?: string } | undefined)?.status;
  if (opts.now && details.expiresAt) details.expired = Date.parse(details.expiresAt) < new Date(opts.now).getTime();

  // Resolve the key.
  let key: Jwk | PublicJwk | undefined;
  if (opts.publicKey) {
    key = opts.publicKey;
    details.pinnedKey = true;
  } else if (opts.jwks) {
    if (typeof prov.key_ref !== "string") return bad("no_public_key", "manifest has no key_ref to look up in the supplied JWKS", details);
    key = lookup(opts.jwks, prov.key_ref);
    if (!key) return bad("no_public_key", `key_ref ${prov.key_ref} not found in the supplied JWKS`, details);
    details.pinnedKey = true;
  } else if (typeof prov.public_key === "string") {
    key = { kty: "OKP", crv: "Ed25519", x: prov.public_key };
    if (!isEd25519Jwk(key)) return bad("malformed", "provenance.public_key is not a valid Ed25519 key", details);
    if (typeof prov.key_ref === "string" && prov.key_ref !== (await thumbprint(key))) {
      return bad("key_mismatch", "key_ref does not match the embedded public key", details);
    }
  }
  if (!key || !isEd25519Jwk(key)) return bad("no_public_key", "no public key available (none embedded, none supplied)", details);

  let payload: Record<string, unknown>;
  let canonical: Uint8Array;
  try {
    payload = signingPayload(m as Record<string, unknown> & { provenance: Record<string, unknown> });
    canonical = canonicalBytes(payload);
  } catch (e) {
    return bad("malformed", `manifest cannot be canonicalised: ${e instanceof Error ? e.message : String(e)}`, details);
  }
  details.payloadDigest = await sha256Hex(canonical);
  const id = await contentId(payload);
  details.contentId = id;

  // Content address first: tampering with the payload shows up here.
  if (prov.content_id === undefined) {
    if (opts.requireContentId) return bad("content_address_mismatch", "provenance.content_id is missing", details);
  } else if (prov.content_id !== id) {
    return bad("content_address_mismatch", "payload does not match provenance.content_id (manifest was modified)", details);
  }

  try {
    fromBase64Url(prov.signature);
  } catch {
    return bad("malformed", "provenance.signature is not base64url", details);
  }
  const ok = await verifyBytes(key, prov.signature, canonical);
  return ok ? { ok: true, code: "ok", details } : bad("signature_invalid", "signature does not verify against the supplied / embedded public key", details);
}
