# AI usage declaration, v1

A declaration says what a site permits AI systems to do with its content. One declaration is projected into every machine-readable policy format, so the formats cannot disagree with each other.

It is a **statement**, not an enforcement mechanism. Nothing served over HTTP can stop a crawler. The value is that what you said is precise, consistent across formats, and can be shown later.

Status: draft for the iSpeakLLM 1.0 line. The reference implementation is `@ispeakllm/policy`. The JSON Schema is [`declaration.schema.json`](./declaration.schema.json). Golden outputs are under `conformance/policy-*`.

## Model

Six **subjects**, three **stances**.

| Subject | Meaning |
|---|---|
| `index` | Indexing for search and retrieval |
| `infer` | Retrieval at inference time: RAG, browsing, tool use |
| `quote` | Reproducing passages in an answer |
| `embed` | Deriving embeddings or other transformed representations |
| `train` | Using the content as training data |
| `evaluate` | Using it to evaluate or benchmark a model |

| Stance | Meaning |
|---|---|
| `allow` | Permitted, unconditionally |
| `deny` | Not permitted |
| `conditional` | Permitted only under a stated `condition` (required, one line) |

A subject the declaration does not mention is **silent**. Silence is neither permission nor refusal. No projection turns silence into either: a silent axis is omitted from every output.

```json
{
  "domain": "example.com",
  "defaults": [
    { "subject": "index", "stance": "allow" },
    { "subject": "infer", "stance": "conditional", "condition": "attribution required" },
    { "subject": "train", "stance": "deny" }
  ],
  "paths": [
    { "pattern": "/blog/", "directives": [{ "subject": "train", "stance": "allow" }] }
  ],
  "agents": [
    { "agent": "Claude-User", "directives": [{ "subject": "quote", "stance": "allow" }] }
  ],
  "contact": "ai@example.com"
}
```

### Layers

1. **`defaults`**: domain-wide stances. At least one directive is required.
2. **`paths`**: per-path overrides. A pattern is a path prefix (`/blog/`; a trailing `*` is allowed and dropped). Overrides apply per subject, and a longer prefix overrides a shorter one. `/` is not a valid pattern; use `defaults`.
3. **`agents`**: per-agent overrides keyed by robots product token.
   - A **restrictive** override (`deny`, `conditional`) applies to anyone presenting that token.
   - A **loosening** override (`allow`) applies only when the request's identity is **verified** (see `@ispeakllm/agents`, grade `verified`). A static file cannot verify anyone, so loosening overrides are never written to robots.txt, headers or any other artifact. The renderer lists them in `notes`.

### Validation

Reject, with a typed code and a path, any declaration that has: no domain or an invalid one; no default directives; an unknown subject or stance; the same subject twice in one list; a `conditional` without a (non-blank, single-line) condition; a condition on `allow`/`deny`; an invalid, root or duplicate path; an invalid or duplicate agent (compared case-insensitively); or an override with no directives. JSON Schema cannot express the "no duplicate subject" and "no duplicate path or agent" rules, so a validator must check those in addition to the schema.

### Canonical form and id

The canonical form lower-cases the domain, sorts directives by subject order (`index, infer, quote, embed, train, evaluate`), sorts paths by pattern and agents by lower-cased token, trims text, fills `version` (default 1) and writes every optional field explicitly (`null` when absent). It is serialised as JSON with sorted keys and no whitespace (identical to JCS, RFC 8785, for this value space).

The declaration id is `emd_` followed by the base64url SHA-256 of those bytes. The same declaration has the same id on any machine.

## Projections

All projections come from the same per-scope view (the root plus one scope per declared path, each with its inherited stances). **No projection is ever more permissive than the declaration.**

### Axes

| Axis | Fed by |
|---|---|
| `search` | `index` |
| `ai-input` | `infer`, `quote`, `embed` |
| `ai-train` | `train`, `evaluate` |

For one axis: all contributing subjects silent gives *omit*. Every declared contributor `allow` gives *yes*. Anything else (any `deny`, any `conditional`) gives *no*. A `conditional` is never collapsed to *yes*, because a binary format cannot carry the condition.

### Formats

| Artifact | Rule |
|---|---|
| `Content-Signal` response header and robots.txt line | The three axes as `search=yes, ai-input=no, ai-train=no`, silent axes omitted. The header is computed per path. The robots.txt line has no path syntax, so it carries the most restrictive value over every scope (`yes` only if every scope says yes). |
| IETF AIPREF `Content-Usage` header and robots.txt `Content-Usage` rule (draft-ietf-aipref-vocab, draft-ietf-aipref-attach) | Categories `train-ai`, `ai-use`, `search`, values `y`/`n`. `train-ai` follows `ai-train`, `search` follows `search`. `ai-use` is `y` only if all five AI subjects (`train, evaluate, infer, quote, embed`) are declared `allow`, `n` if at least one is declared and none is `allow`, and omitted when mixed. In robots.txt a path rule is `Content-Usage: /path/ train-ai=y`, written with the complete effective values for that path (longest-path matching replaces, it does not merge). |
| `User-Agent: __usage_ai-training` robots token (draft-kelley-aipref-training-preference-signal) | Driven by the `ai-train` axis: `Disallow: /` for *no*, `Allow: /` for *yes*, nothing when silent. Path differences are written as `Allow`/`Disallow` lines. |
| Per-UA robots.txt groups | `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-SearchBot`, `Claude-User`, `Google-Extended`, `PerplexityBot`, `CCBot`, `Applebot-Extended`, `Bytespider`, `meta-externalagent`. Training crawlers follow `train`, search crawlers follow `index`, user-triggered agents follow `infer`. A group appears only where every subject the agent serves is declared and none is `allow` (`Disallow`), or to carve a declared allow out of a declared block (`Allow`). A user agent never gets an unprompted `Allow`. Restrictive per-agent overrides add or tighten groups, including for agents outside this list. |
| RSL 1.0 XML | One `<content url="https://domain/path*">` per scope with `<permits>`/`<prohibits>` of `ai-train`, `ai-input`, `search`, collapsed to `all` when all three agree. `conditional` is listed under `<prohibits>` with the condition in a comment. A `licence` that is an `https://` URL becomes `<terms>` on the root scope. Omitted entirely when silent. |
| `ai.txt` | A readable summary, one `Scope:` section per scope: `Allow-Use`, `Disallow-Use`, `Conditional-Use`, plus the Content-Signal, Content-Usage and TDM values. Silent subjects are not listed. |
| TDM reservation (W3C TDMRep) | `tdm-reservation` header and `/.well-known/tdmrep.json`: `1` (reserved) when `ai-train` is *no*, `0` when *yes*, absent when silent. Entries are ordered most specific first. `tdm-policy` is carried only when a policy URL is configured. |

robots.txt (RFC 9309) expresses crawl access per user-agent, not per purpose. Where that cannot represent the declaration, the renderer says so in `notes` rather than approximating.

### Signal calendar

`@ispeakllm/policy` ships the dates vendors have given for honouring `__usage_ai-training`, as announced on 30 Oct 2026 (research notes of 10 Nov 2026): Google, early 2027; Microsoft, 1 Feb 2027; OpenAI, "the coming months" (foundational training); Anthropic, rollout under way with no date. It records what was announced, not what any crawler does.

### Conformance

A conforming renderer, given `conformance/policy-*/declaration.json`, produces byte-identical `robots.txt`, `rsl.xml`, `aipref.txt`, `ai.txt` and `headers.json` (set `UPDATE_GOLDEN=1` to regenerate when the spec changes). The reference test suite also runs a seeded property test over more than 500 random declarations that parses every rendered artifact and checks that none is more permissive than the declaration, and that silence emits nothing.

## Licence

This specification: CC BY 4.0 (to be confirmed with the repository licence decision).
