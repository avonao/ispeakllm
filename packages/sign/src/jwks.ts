/** JWKS (RFC 7517) builder and reader for Ed25519 public keys. `kid` is the RFC 7638 thumbprint unless the key already has one. */

import { isEd25519Jwk, thumbprint, toPublicJwk, type Jwk, type PublicJwk } from "./keys";

export type Jwks = { keys: PublicJwk[] };

/** Build a JWKS from public or private JWKs. Private material is always stripped; entries are sorted by `kid` and de-duplicated. */
export async function buildJwks(keys: (Jwk | PublicJwk)[]): Promise<Jwks> {
  const byKid = new Map<string, PublicJwk>();
  for (const k of keys) {
    if (!isEd25519Jwk(k)) throw new Error("@ispeakllm/sign: JWKS entries must be Ed25519 OKP JWKs");
    const pub = toPublicJwk(k as Jwk);
    const kid = pub.kid ?? (await thumbprint(pub));
    byKid.set(kid, { kty: "OKP", crv: "Ed25519", x: pub.x, kid, alg: "EdDSA", use: "sig" });
  }
  return { keys: [...byKid.values()].sort((a, b) => (a.kid! < b.kid! ? -1 : a.kid! > b.kid! ? 1 : 0)) };
}

export type JwksReader = {
  keys: PublicJwk[];
  get(kid: string): PublicJwk | undefined;
};

/**
 * Read a JWKS (object or JSON text). Unsupported key types are skipped (RFC 7517 says
 * readers ignore keys they cannot use); entries without a `kid` get their thumbprint.
 * Throws if the document is not a JWKS at all.
 */
export async function readJwks(input: unknown): Promise<JwksReader> {
  const doc: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const list = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new Error("@ispeakllm/sign: not a JWKS (missing 'keys' array)");
  const usable = list.filter((k) => isEd25519Jwk(k)) as Jwk[];
  const jwks = await buildJwks(usable);
  const map = new Map(jwks.keys.map((k) => [k.kid!, k]));
  return { keys: jwks.keys, get: (kid) => map.get(kid) };
}
