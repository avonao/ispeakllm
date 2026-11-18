<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ispeakllm-logo-light.avif">
    <img src="docs/assets/ispeakllm-logo.avif" alt="iSpeakLLM" width="380">
  </picture>
</h1>

Make any website easy for AI agents to read, from your own content, on any host. MIT licensed.

iSpeakLLM builds on the [llms.txt](https://llmstxt.org/) standard. From a folder of Markdown it generates
everything an agent looks for, and it serves that with the same HTTP behaviour on every runtime:

- **`/llms.txt` and `/llms-full.txt`**: the site index and the full text, in llms.txt v2 form.
- **A Markdown version of every page**: at `/<page>.md`, and on the page URL itself when the request sends
  `Accept: text/markdown`. Responses carry `Vary: Accept`, an ETag (with `304 Not Modified`) and `x-markdown-tokens`.
  Browsers still get your HTML, unchanged.
- **Your AI-use terms, stated once**: one small declaration (index yes, training no, per path) becomes
  `Content-Signal` and `Content-Usage` (IETF AIPREF) headers, a robots.txt block including `__usage_ai-training`,
  ai.txt, RSL 1.0 and a TDM reservation.
- **A signed manifest**: `/.well-known/ai-conformance.json`, signed with your own Ed25519 key, verifiable offline.
- **A read-only MCP server**: agents can search your pages and read them, your policy and your manifest.
- **Tools**: an llms.txt linter and an agent-readiness check for any live site.

It also grades agents honestly: a User-Agent string is only a claim, and only a verified RFC 9421 Web Bot Auth
signature names an operator.

## Quickstart

Requires Node.js 20 or newer. Packages are not on npm yet, so build from source:

```bash
git clone https://github.com/avonao/ispeakllm && cd ispeakllm
npm install && npm run build
cd examples/basic-site
node ../../packages/cli/dist/ispeakllm.mjs generate
node ../../packages/cli/dist/ispeakllm.mjs serve
curl -H 'Accept: text/markdown' http://127.0.0.1:4321/docs/quickstart
```

The full walkthrough (your own site, a policy, signing, checking a live site) is in [docs/quickstart.md](docs/quickstart.md).

## The CLI

```
ispeakllm init                  create ispeakllm.config.json and content/
ispeakllm generate              build llms.txt, page .md files, policy files, the manifest and the adapter bundle
ispeakllm lint <file|url>       check an llms.txt
ispeakllm check <origin>        agent-readiness report for a live site
ispeakllm keys                  create an Ed25519 signing key (kept out of git)
ispeakllm sign <file>           detached signature
ispeakllm verify <file>         verify a signed manifest or a detached signature
ispeakllm serve                 serve the output locally with Markdown negotiation
```

## Run it on your stack

`ispeakllm generate` writes one bundle file (`.ispeakllm/bundle.json`). Every adapter serves it the same way and passes
the same conformance suite. Setup for each is in [docs/adapters.md](docs/adapters.md).

| Runtime | Where |
|---|---|
| Cloudflare Worker in front of any site | `adapters/edge-worker` |
| Next.js (also on Workers via OpenNext) | `adapters/next` |
| Express / Node, Hono (Workers, Bun, Deno) | `adapters/express`, `adapters/hono` |
| SvelteKit, Nuxt, Angular SSR, Shopify App Proxy | `integrations/svelte`, `vue`, `angular`, `shopify` |
| WordPress, Laravel, Drupal, Django/Flask (WSGI), Rack/Rails, Go | `integrations/…` ([status](integrations/README.md)) |
| Spring, ASP.NET Core | `integrations/spring`, `aspnetcore`: written with tests, **not yet run** (experimental) |

Static site with no server? Upload `public/` as it is: `llms.txt` and the `.md` files work without any adapter.
Only the `Accept: text/markdown` negotiation and the policy headers need one.

## What's in the repo

| Path | What |
|---|---|
| `packages/core` | llms.txt engine, content adapters, negotiation, HTTP helpers, languages, audience views, llms-ctx export (no dependencies) |
| `packages/policy` | the AI-use declaration and its projections (no dependencies) |
| `packages/sign` | JCS (RFC 8785), Ed25519 keys, JWKS, signed manifests, detached signatures (no dependencies) |
| `packages/agents` | Web Bot Auth / RFC 9421, identity grades, rDNS, CIDR, fetch log |
| `packages/html-md` | HTML-to-Markdown fallback for pages without Markdown source |
| `packages/lint`, `packages/mcp` | linter and readiness check; read-only MCP server |
| `packages/serve` | the request handler every JS adapter uses |
| `packages/cli` | the `ispeakllm` command |
| `adapters/`, `integrations/` | runtimes and frameworks (table above) |
| `spec/` | [specifications](spec/README.md) with JSON schemas |
| `conformance/` | golden outputs, test vectors and the adapter HTTP suite |
| `examples/basic-site` | a small site to try everything on |

## Develop

```bash
npm test                                    # JS tests
npx vitest run packages/core                # one package
node conformance/adapter-http/runner.mjs http://127.0.0.1:8080 --level core   # check any adapter over HTTP
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## What it does not promise

iSpeakLLM makes your content easy and unambiguous for agents to read and states your terms. It does not promise
traffic, ranking or citations, and preference signals block nothing. Details: [docs/no-promises.md](docs/no-promises.md).

## Licence

[MIT](LICENSE). See [NOTICE](NOTICE) for provenance and third-party test vectors.
