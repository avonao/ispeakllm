# Adapter bundle v1

`ispeakllm generate` writes `.ispeakllm/bundle.json`. Every adapter (Worker, Next.js, Express, Hono,
SvelteKit, Nuxt, Angular, Shopify, and the PHP, Python, Ruby, Go, Java and .NET ports) serves from it,
so a site has one build step and every runtime answers the same way.

Schema: [bundle.schema.json](bundle.schema.json). Example: [conformance/adapter-http/bundle.json](../../conformance/adapter-http/bundle.json).

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `generatedAt` | ISO-8601 time of the build. |
| `origin` | Site origin, no trailing slash. Optional. |
| `files` | Site path → `{ type, body, etag, tokens? }`. Includes `/llms.txt`, `/llms-full.txt`, each page's `.md`, the policy files and `/.well-known/ai-conformance.json`. `etag` is `"` + first 32 hex characters of SHA-256(body) + `"`. `tokens` (Markdown only) is ceil(UTF-8 bytes / 4). Both are precomputed so ports need no hashing. |
| `corpus` | Pages and policy for the read-only MCP tools. |
| `declaration` | The AI-use declaration ([spec/declaration](../declaration/README.md)), when one is configured. |
| `pathHeaders` | Policy response headers per scope: `"/"` plus each declared path prefix. A port picks the longest key that is a prefix of the request path. Header names are lower-case. |

The bundle holds no secrets: the signing key never enters it, only the signed manifest and the public JWKS.
