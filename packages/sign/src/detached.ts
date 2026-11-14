/**
 * Detached signatures for arbitrary bytes (llms.txt, llms-full.txt, page .md).
 *
 * The envelope (a small JSON document, served e.g. at `<file>.sig.json`) is:
 *   { "typ": "ispeakllm-detached/1", "algorithm": "Ed25519", "key_ref": "...",
 *     "signed_at": "...", "content_id": "ispk_...", "signature": "..." }
 * `content_id` is the content address of the exact bytes. The signature covers
 * JCS({typ, algorithm, key_ref, signed_at, content_id}), which commits to the bytes
 * through the SHA-256 content address and binds the key id and timestamp. Verification
 * recomputes the content address first, so a changed byte is reported as such.
 */

import { canonicalBytes } from "./jcs";
import { contentIdOfBytes } from "./hash";
import { signBytes, verifyBytes, thumbprint, isEd25519Jwk, type Jwk, type PublicJwk } from "./keys";
import type { Jwks, JwksReader } from "./jwks";
import type { VerifyCode, VerifyResult } from "./manifest";

export const DETACHED_TYP = "ispeakllm-detached/1" as const;

export type DetachedSignature = {
  typ: typeof DETACHED_TYP;
  algorithm: "Ed25519";
  key_ref: string;
  signed_at: string;
  content_id: string;
  signature: string;
};

export type DetachedSignOptions = { signedAt?: string; keyRef?: string };

const message = (e: Omit<DetachedSignature, "signature">): Uint8Array =>
  canonicalBytes({ typ: e.typ, algorithm: e.algorithm, key_ref: e.key_ref, signed_at: e.signed_at, content_id: e.content_id });

export async function signDetached(bytes: string | Uint8Array, privateKey: Jwk, opts: DetachedSignOptions = {}): Promise<DetachedSignature> {
  if (!isEd25519Jwk(privateKey) || !privateKey.d) throw new Error("@ispeakllm/sign: signDetached needs a private Ed25519 JWK");
  const head = {
    typ: DETACHED_TYP,
    algorithm: "Ed25519" as const,
    key_ref: opts.keyRef ?? privateKey.kid ?? (await thumbprint(privateKey)),
    signed_at: opts.signedAt ?? new Date().toISOString(),
    content_id: await contentIdOfBytes(bytes),
  };
  return { ...head, signature: await signBytes(privateKey, message(head)) };
}

export type DetachedVerifyOptions = {
  /** Verification key (required unless `jwks` is given). */
  publicKey?: Jwk | PublicJwk;
  /** Keys by `key_ref`. */
  jwks?: Jwks | JwksReader;
};

const bad = (code: VerifyCode, reason: string, kid?: string, contentId?: string): VerifyResult => ({ ok: false, code, reason, details: { kid, contentId } });

export async function verifyDetached(bytes: string | Uint8Array, envelope: unknown, opts: DetachedVerifyOptions): Promise<VerifyResult> {
  const e = (typeof envelope === "string" ? safeParse(envelope) : envelope) as Partial<DetachedSignature> | null;
  if (!e || typeof e !== "object") return bad("malformed", "signature envelope must be a JSON object");
  if (e.typ !== DETACHED_TYP || e.algorithm !== "Ed25519") return bad("unsupported_envelope", "unsupported detached-signature envelope", e.key_ref);
  if (typeof e.key_ref !== "string" || typeof e.signed_at !== "string" || typeof e.content_id !== "string" || typeof e.signature !== "string") {
    return bad("malformed", "envelope is missing key_ref, signed_at, content_id or signature", e.key_ref);
  }
  let key: Jwk | PublicJwk | undefined = opts.publicKey;
  if (!key && opts.jwks) {
    key = typeof (opts.jwks as JwksReader).get === "function" ? (opts.jwks as JwksReader).get(e.key_ref) : (opts.jwks as Jwks).keys.find((k) => k.kid === e.key_ref);
  }
  if (!key || !isEd25519Jwk(key)) return bad("no_public_key", "no public key supplied for this signature", e.key_ref);
  const id = await contentIdOfBytes(bytes);
  if (id !== e.content_id) return bad("content_address_mismatch", "bytes do not match the signed content_id (content was modified)", e.key_ref, id);
  const ok = await verifyBytes(key, e.signature, message(e as Omit<DetachedSignature, "signature">));
  return ok
    ? { ok: true, code: "ok", details: { kid: e.key_ref, signedAt: e.signed_at, contentId: id, pinnedKey: true } }
    : bad("signature_invalid", "signature does not verify", e.key_ref, id);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
