# Fetch log record: `ispeakllm.fetch/1`

One NDJSON line per agent fetch, written by `@ispeakllm/serve` when a fetch log is configured
(the Worker stores them in KV). Schema: [fetch-log.schema.json](fetch-log.schema.json).

## Identity grades
Grades come from the RFC 9421 / Web Bot Auth signature check only:

| Grade | Meaning |
|---|---|
| `verified` | The signature verified against the agent's published key. Only this grade names an `operator`. |
| `failed` | A signature was present and is cryptographically wrong, expired or dated in the future. |
| `unauthenticated` | No signature. A `User-Agent` such as `GPTBot` is recorded as `claimedAgent`, never as the operator, even when the IP range matches. |
| `unchecked` | A signature could not be checked (malformed, unknown key, directory unreachable). |

`network` records extra evidence (`claimed`, `ip-verified`, `rdns-verified`); it never upgrades the grade.

## Privacy
The address is replaced by `ipHash` = `ip1_` + the first 128 bits of HMAC-SHA256(salt, normalised IP).
A record with any raw-IP field (`ip`, `clientIp`, …) is rejected by the parser. The salt is a secret
of the site operator, so hashes cannot be compared across sites.

## Drift
`contentSha256` is the hash of exactly the bytes served. Comparing it with the current file shows which
verified agents still hold an older version. Drift is reported as a fact, not judged: records carry no severity.
