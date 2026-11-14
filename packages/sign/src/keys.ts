/** Ed25519 keys via WebCrypto, as JWK (RFC 8037), with RFC 7638 thumbprints as key ids. */

import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import { sha256 } from "./hash";

export type Jwk = {
  kty: "OKP";
  crv: "Ed25519";
  /** Public key, base64url (32 bytes). */
  x: string;
  /** Private seed, base64url (32 bytes). Never publish. */
  d?: string;
  kid?: string;
  alg?: "EdDSA";
  use?: "sig";
};

export type PublicJwk = Omit<Jwk, "d">;

export type KeyPair = { kid: string; publicKey: PublicJwk; privateKey: Jwk };

export function isEd25519Jwk(k: unknown): k is Jwk {
  const o = k as Partial<Jwk> | null;
  return !!o && o.kty === "OKP" && o.crv === "Ed25519" && typeof o.x === "string" && o.x.length === 43 && (o.d === undefined || (typeof o.d === "string" && o.d.length === 43));
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url) of the public part. For OKP keys the
 * required members are `crv`, `kty`, `x`, in lexicographic order, no whitespace.
 */
export async function thumbprint(jwk: Pick<Jwk, "crv" | "kty" | "x">): Promise<string> {
  const json = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
  return toBase64Url(await sha256(utf8(json)));
}

/** Generate an Ed25519 key pair. `kid` is the RFC 7638 thumbprint; both JWKs carry it. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const x = priv.x!;
  const d = priv.d!;
  const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x });
  const publicKey: PublicJwk = { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" };
  return { kid, publicKey, privateKey: { ...publicKey, d } };
}

/** Export a key pair as plain JSON-able JWKs (identity helper kept for symmetry with `importKeyPair`). */
export function exportKeyPair(pair: KeyPair): { publicKey: PublicJwk; privateKey: Jwk } {
  return { publicKey: { ...pair.publicKey }, privateKey: { ...pair.privateKey } };
}

/** Import a private JWK (must contain `d`), validating it and filling in `kid` if absent. */
export async function importKeyPair(privateJwk: Jwk): Promise<KeyPair> {
  if (!isEd25519Jwk(privateJwk) || !privateJwk.d) throw new Error("@ispeakllm/sign: a private Ed25519 JWK with 'd' is required");
  await importPrivate(privateJwk); // throws if the key is unusable
  const kid = privateJwk.kid ?? (await thumbprint(privateJwk));
  const publicKey: PublicJwk = { kty: "OKP", crv: "Ed25519", x: privateJwk.x, kid, alg: "EdDSA", use: "sig" };
  return { kid, publicKey, privateKey: { ...publicKey, d: privateJwk.d } };
}

export function toPublicJwk(jwk: Jwk): PublicJwk {
  const { d: _d, ...rest } = jwk;
  return rest;
}

export async function importPrivate(jwk: Jwk): Promise<CryptoKey> {
  if (!jwk.d) throw new Error("@ispeakllm/sign: signing needs a private JWK (missing 'd')");
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d } as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
}

export async function importPublic(jwk: Jwk | PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x } as JsonWebKey, { name: "Ed25519" }, false, ["verify"]);
}

/** Raw Ed25519 signature over `message`, base64url. */
export async function signBytes(privateJwk: Jwk, message: Uint8Array): Promise<string> {
  const key = await importPrivate(privateJwk);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message as unknown as BufferSource)));
}

/** Verify a base64url Ed25519 signature. Returns false (never throws) on any malformed input. */
export async function verifyBytes(publicJwk: Jwk | PublicJwk, signature: string, message: Uint8Array): Promise<boolean> {
  try {
    const sig = fromBase64Url(signature);
    if (sig.length !== 64) return false;
    const key = await importPublic(publicJwk);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as unknown as BufferSource, message as unknown as BufferSource);
  } catch {
    return false;
  }
}
