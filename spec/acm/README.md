# AI Conformance Manifest (ACM) v1

A small JSON document, served at `/.well-known/ai-conformance.json`, in which a site declares:

- who publishes it (`issuer`),
- which AI systems operate on the site and how they are disclosed (`ai_disclosure`, aligned with the interaction categories of EU AI Act Article 50),
- the public content surface (`content_map`: sections, pages, per-page `.md` URL and content hash),
- optional links to policy documents, a consent configuration reference, and how to verify the manifest,
- and, once signed, a `provenance` envelope.

The schema is [`acm.schema.json`](./acm.schema.json) (JSON Schema draft 2020-12, `spec_version` `"1.0"`).

## What it is not

- It is not a legal requirement. Article 50's disclosure duty is owed to people, on the site; the manifest is additional, machine-readable governance.
- It makes no promise about traffic, ranking or citations.
- It is not a permission system. Access and usage rules live in the declaration/policy layer (robots, Content-Signal, AIPREF); the ACM does not override them.
- Nobody consumes it universally yet. That is stated plainly so a publisher can decide on the merits.

## Lifecycle

1. `@ispeakllm/core` `generate()` renders `llms.txt`, `llms-full.txt` and per-page Markdown. Each page gets a SHA-256 `hash`.
2. `buildAcmShell()` turns the generated pages plus the issuer and disclosure inputs into the **unsigned shell**: every field except `provenance`. It is deterministic.
3. `@ispeakllm/sign` `signManifest(shell, privateKey)` adds `provenance` (see [../signing](../signing/README.md)).
4. The site serves the signed manifest. Anyone can verify it offline with `verifyManifest()` or `ispeakllm verify`.

An unsigned shell is a valid hand-off artifact but is not a valid served ACM: `provenance` is required by the schema, and a manifest without it must not be presented as signed.

## Fields

| Field | Required | Notes |
|---|---|---|
| `spec_version` | yes | `"1.0"` |
| `domain` | yes | Hostname the manifest describes. |
| `issued_at` | yes | RFC 3339 date-time of this version. |
| `expires_at` | no | Freshness boundary. Past it, a fetcher should re-fetch. Informational for verification. |
| `content_source` | no | `source-connected` (default) or `managed-crawl`. `managed-crawl` is the explicitly degraded mode (content recovered from rendered HTML rather than the site's own source) and consumers must treat it as lower fidelity. |
| `issuer` | yes | `name` required; `legal_entity`, `contact`, `jurisdiction` optional. |
| `ai_disclosure` | yes | `systems[]`: `id`, `category`, `purpose` required; `provider`, `user_facing_disclosure`, `human_oversight`, `data_handling`, `synthetic_media`, `high_risk` (operator self-declaration, not a legal determination) optional. `systems` may be empty. |
| `consent` | no | Reference to the consent configuration (`config_ref`), declared `categories`, `framework`. |
| `content_map` | yes | `pages[]` (`path`, `title` required; `summary`, `section`, `priority`, `last_modified`, `md_url`, `content_hash`), optional ordered `sections[]`. |
| `policies` | no | Links: `privacy`, `ai_policy`, `terms`. |
| `verification` | no | `endpoint`, `jwks_uri`, `instructions`. |
| `provenance` | yes | Signing envelope, below. |

`content_hash` is the SHA-256 (hex) of the exact bytes served at the page's `.md` URL, so a consumer can detect drift between the manifest and the content.

## Provenance

```json
"provenance": {
  "algorithm": "Ed25519",
  "canonicalization": "JCS/RFC8785",
  "signed_at": "2026-06-15T12:00:00.000Z",
  "key_ref": "YAoE0eiCsfEFXDtGomqDhwc86ZEjqpkeiBXlXmj8tG0",
  "public_key": "ZkWd1O0lRfyD_6e7j4QN-gI7J7SH7G921qVHfQgxz8Y",
  "content_id": "ispk_97bbZYXPO1_ciYHomvDtRNeq81L7ac66UWUCgrOf-SM",
  "signature": "..."
}
```

- `signature`, `anchor` and `content_id` are excluded from the signed payload; everything else in the manifest, including every other `provenance` member, is signed.
- `content_id` is the content address of that payload. It is a convenience and an early tamper check, not a trust anchor: trust comes from the signature and the key.
- `anchor` is optional third-party timestamp evidence added after signing; the manifest verifies from `signed_at` without it.

## Versioning

`spec_version` follows `MAJOR.MINOR`. Additive optional fields are minor. The schema sets `additionalProperties: false`, so extensions require a version bump rather than ad-hoc fields.
