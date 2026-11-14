# IspeakLLM

Open-source toolkit that makes any website readable for AI agents, on any host, from the site's own sources.
It builds on the [llms.txt](https://llmstxt.org/) standard and goes past "convert HTML to Markdown at the edge":

- **Speak**: llms.txt (v2), llms-full.txt, per-page Markdown, `Accept: text/markdown` negotiation with `Vary`,
  ETag/304 and `x-markdown-tokens`. Markdown comes from your sources, with an HTML-to-Markdown fallback.
- **Declare**: one AI-use declaration compiled to Content-Signal, IETF AIPREF (`Content-Usage`), the
  `__usage_ai-training` robots block, robots.txt, RSL 1.0, ai.txt and TDM reservation, per path.
- **Prove**: an AI Conformance Manifest signed with your own Ed25519 key (JCS, RFC 8785), verifiable offline.
- **Know**: honest agent identity grading. A User-Agent is a claim; only a verified RFC 9421 Web Bot Auth signature
  names an operator. Fetch records hash the exact bytes served, so you can see who holds an outdated version.
- **Answer**: a read-only MCP server for your site (search, pages, policy, manifest).
- **Check**: an llms.txt linter and an agent-readiness checker for any live site.

Status: pre-release (0.1.0), private. Licence: [MIT](LICENSE). Packages: `@ispeakllm/*`.

## Quickstart
See [docs/quickstart.md](docs/quickstart.md). In short:

```bash
npm install && npm run build
cd examples/basic-site
node ../../packages/cli/dist/ispeakllm.mjs generate
node ../../packages/cli/dist/ispeakllm.mjs serve
curl -H 'Accept: text/markdown' http://127.0.0.1:4321/docs/quickstart
```

## Where it runs
One build step (`ispeakllm generate`) writes a bundle; every adapter serves it the same way and passes the
same conformance suite ([docs/adapters.md](docs/adapters.md)):

| Runtime | Package |
|---|---|
| Cloudflare Worker in front of any host | `@ispeakllm/edge-worker` |
| Next.js (incl. OpenNext on Workers) | `@ispeakllm/next` |
| Express / Node, Hono (Workers, Bun, Deno) | `@ispeakllm/express`, `@ispeakllm/hono` |
| SvelteKit, Nuxt, Angular SSR, Shopify App Proxy | `@ispeakllm/sveltekit`, `@ispeakllm/nuxt`, `@ispeakllm/angular`, `@ispeakllm/shopify` |
| WordPress, Laravel, Drupal, Django/Flask, Rack/Rails, Go, Spring, ASP.NET Core | [integrations/](integrations/README.md) |

## Repository
| Path | What |
|---|---|
| `packages/core` | llms.txt engine, content adapters, negotiation, HTTP helpers, languages, views, llms-ctx (zero deps) |
| `packages/policy` | declaration model and projections (zero deps) |
| `packages/sign` | JCS, Ed25519, JWKS, signed manifests, detached signatures (zero deps) |
| `packages/agents` | Web Bot Auth / RFC 9421, identity grades, rDNS, CIDR, fetch log and drift |
| `packages/html-md` | HTML-to-Markdown fallback |
| `packages/lint`, `packages/mcp` | linter + readiness checker; read-only MCP server |
| `packages/serve` | the one request handler every adapter uses |
| `packages/cli` | `ispeakllm` command line |
| `spec/` | [specifications](spec/README.md) with JSON schemas |
| `conformance/` | golden outputs, test vectors, the adapter HTTP suite |

```bash
npm test             # every test
npm run typecheck
```

## What it does not promise
IspeakLLM makes your content easy and unambiguous for agents to read and states your terms. It does not promise
traffic, ranking, citations or that any agent honours your preferences. See [docs/no-promises.md](docs/no-promises.md).
