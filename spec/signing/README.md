# Signing profile v1

How IspeakLLM artifacts are signed and verified. The reference implementation is `@ispeakllm/sign` (zero runtime dependencies; WebCrypto only, so it runs in Node 22, Cloudflare Workers, Deno, Bun and current browsers).

## Primitives

| Purpose | Choice |
|---|---|
| Signature | Ed25519 (RFC 8032), via WebCrypto `Ed25519` |
| Canonical JSON | JCS, RFC 8785 |
| Hash | SHA-256 |
| Key format | JWK, `kty: "OKP"`, `crv: "Ed25519"` (RFC 8037) |
| Key id (`kid`, `key_ref`) | RFC 7638 JWK thumbprint (SHA-256, base64url) over `{"crv":"Ed25519","kty":"OKP","x":"<x>"}` |
| Key discovery | JWKS (RFC 7517) at a URL the publisher chooses (`verification.jwks_uri`) or embedded `provenance.public_key` |
| Encoding | base64url without padding (RFC 4648 section 5) |

Verifiers MUST reject signatures that are not exactly 64 bytes, and base64url input with padding or characters outside the URL-safe alphabet.

## 1. Canonicalisation

Implemented exactly as RFC 8785: members sorted by UTF-16 code units, ECMAScript number serialisation, minimal string escaping, no whitespace. Additional rules for signed data:

- Only JSON values: objects, arrays, strings, finite numbers, booleans, null. NaN, Infinity, bigint, functions and non-plain objects are errors.
- Strings with lone surrogates are errors (I-JSON).
- `undefined` object members are omitted; `undefined` inside an array is an error.

Conformance vectors: `conformance/sign-vectors/` (RFC 8785 Appendix B number table, Ed25519 RFC 8032 test vectors).

## 2. Content-addressed ids

```
contentId(value)      = "ispk_" + base64url(SHA-256(JCS(value)))
contentIdOfBytes(b)   = "ispk_" + base64url(SHA-256(b))
```

An id is always `ispk_` followed by 43 base64url characters. Equal content gives an equal id, independent of key order or formatting.

## 3. Signed manifests (ACM)

Input: the unsigned shell (see [../acm](../acm/README.md)).

1. Build `provenance` with `algorithm: "Ed25519"`, `canonicalization: "JCS/RFC8785"`, `signed_at`, `key_ref` and, unless disabled, `public_key` (the JWK `x`).
2. The **signing payload** is the manifest with `provenance` minus `signature`, `anchor` and `content_id`. Every other member is part of the payload, so no unsigned member can ride in the envelope.
3. `content_id = contentId(payload)`.
4. `signature = base64url(Ed25519(privateKey, UTF-8(JCS(payload))))`.
5. Output: the shell plus `provenance` carrying `content_id` and `signature`.

Signatures are deterministic: the same payload and key give the same bytes.

### Verification order

1. **Envelope.** `provenance` present, `algorithm` and `canonicalization` as above, `signature` is base64url. Otherwise `unsupported_envelope` or `malformed`.
2. **Key.** In order of precedence: a key pinned by the caller; a key from a caller-supplied JWKS looked up by `key_ref`; the embedded `public_key`. An embedded key whose thumbprint differs from `key_ref` is `key_mismatch`. No key: `no_public_key`.
3. **Content address.** Recompute `contentId(payload)` and compare with `provenance.content_id`. A difference is `content_address_mismatch`: the document was modified. This runs before the signature check so tampering is reported as such.
4. **Signature.** Verify over the canonical payload. Failure is `signature_invalid` (wrong key, or a forger who recomputed `content_id`).

Trust note: an embedded `public_key` proves integrity and consistency, not identity. For identity, pin the key (or JWKS) obtained from a channel the verifier trusts. `expires_at` is surfaced as `details.expired` when a clock is supplied; it does not by itself fail verification.

### Verdict codes

`ok`, `malformed`, `unsupported_envelope`, `no_public_key`, `key_mismatch`, `content_address_mismatch`, `signature_invalid`.

## 4. Detached signatures (llms.txt, llms-full.txt, page `.md`, any bytes)

A small JSON envelope, conventionally served next to the file as `<file>.sig.json`:

```json
{
  "typ": "ispeakllm-detached/1",
  "algorithm": "Ed25519",
  "key_ref": "<kid>",
  "signed_at": "2026-06-15T12:00:00.000Z",
  "content_id": "ispk_...",
  "signature": "<base64url>"
}
```

- `content_id = contentIdOfBytes(bytes)` over the exact served bytes.
- `signature = Ed25519(privateKey, UTF-8(JCS({typ, algorithm, key_ref, signed_at, content_id})))`. The signature commits to the bytes through the SHA-256 content address and binds the key id and timestamp. The `typ` member provides domain separation: a detached signature cannot be replayed as a manifest signature or the reverse.
- Verification recomputes `content_id` from the bytes first (`content_address_mismatch`), then checks the signature.
- The key must be supplied (pinned key or JWKS by `key_ref`); detached envelopes do not embed one.

## 5. JWKS

`buildJwks(keys)` accepts public or private JWKs, strips private material, sets `alg: "EdDSA"` and `use: "sig"`, assigns `kid` (the thumbprint) when absent, de-duplicates and sorts by `kid`, so the document is stable. `readJwks()` skips key types it cannot use and indexes the rest by `kid`.

Key rotation: publish old and new keys together in the JWKS; sign with the new `key_ref`. Old manifests keep verifying against the old entry.

## 6. Out of scope for v1

Hosted key custody, anchoring services, transparency logs and revocation lists are not part of this profile. The `anchor` member is reserved for third-party timestamp evidence and is excluded from the signature so it can be added later.
