/**
 * The single verification entry used by the CLI (`ispeakllm verify`): a signed
 * manifest or a detached signature over bytes, one verdict shape.
 */

import { verifyManifest, type VerifyOptions, type VerifyResult } from "./manifest";
import { verifyDetached } from "./detached";
import { readJwks } from "./jwks";
import type { Jwk, PublicJwk } from "./keys";

export type VerifyInput =
  | { kind: "manifest"; manifest: unknown }
  | { kind: "detached"; bytes: string | Uint8Array; signature: unknown };

export type VerifyEntryOptions = Omit<VerifyOptions, "jwks" | "publicKey"> & {
  publicKey?: Jwk | PublicJwk | string;
  /** A JWKS document, or its JSON text. */
  jwks?: unknown;
};

export type VerifyVerdict = VerifyResult & { kind: VerifyInput["kind"] };

export async function verify(input: VerifyInput, opts: VerifyEntryOptions = {}): Promise<VerifyVerdict> {
  let publicKey: Jwk | PublicJwk | undefined;
  try {
    publicKey = typeof opts.publicKey === "string" ? (JSON.parse(opts.publicKey) as Jwk) : opts.publicKey;
  } catch {
    return { kind: input.kind, ok: false, code: "malformed", reason: "publicKey is not valid JSON", details: {} };
  }
  let jwks;
  try {
    jwks = opts.jwks === undefined ? undefined : await readJwks(opts.jwks);
  } catch (e) {
    return { kind: input.kind, ok: false, code: "malformed", reason: e instanceof Error ? e.message : String(e), details: {} };
  }
  if (input.kind === "detached") {
    return { kind: "detached", ...(await verifyDetached(input.bytes, input.signature, { publicKey, jwks })) };
  }
  let manifest = input.manifest;
  if (typeof manifest === "string") {
    try {
      manifest = JSON.parse(manifest);
    } catch {
      return { kind: "manifest", ok: false, code: "malformed", reason: "manifest is not valid JSON", details: {} };
    }
  }
  return { kind: "manifest", ...(await verifyManifest(manifest, { publicKey, jwks, requireContentId: opts.requireContentId, now: opts.now })) };
}
