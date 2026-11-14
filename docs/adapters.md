# Adapters

Every adapter serves the bundle that `ispeakllm generate` writes to `.ispeakllm/bundle.json` and behaves as
[spec/adapter-http](../spec/adapter-http/README.md) says. Each one runs the shared suite in its tests
(`conformance/adapter-http`): JS adapters at level **full** (with MCP), the language ports at level **core**.

## Cloudflare Worker (any host behind it)
```ts
// worker.ts (see adapters/edge-worker/template)
import bundle from "./.ispeakllm/bundle.json";
import { createWorker } from "@ispeakllm/edge-worker";
export default createWorker(bundle);
```
Agent requests are answered at the edge; human traffic goes to the zone's origin (or `ISPEAKLLM_UPSTREAM`) and only
gets headers added. Pages without source Markdown are converted from the origin's HTML and marked
`x-ispeakllm-source: html-fallback`. Optional: bind a KV namespace as `FETCH_LOG` and set the secret
`ISPEAKLLM_IP_SALT` to keep graded fetch records (IPs only hashed). Deploying is your step: `wrangler deploy`.

## Next.js
```ts
// middleware.ts
import { NextResponse } from "next/server";
import bundle from "./.ispeakllm/bundle.json";
import { createMiddleware } from "@ispeakllm/next";
export const middleware = createMiddleware(bundle, { NextResponse });
export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
```
Or single files as routes: `export const GET = fileRoute(bundle, "/llms.txt")`.

## Express / Node, Hono
```ts
app.use(ispeakllm(bundle));               // @ispeakllm/express (mount before body parsers)
app.use("*", ispeakllm(bundle));          // @ispeakllm/hono
```

## SvelteKit, Nuxt, Angular SSR
```ts
export const handle = ispeakllmHandle(bundle);                                          // src/hooks.server.ts
export default defineEventHandler(createNitroMiddleware(bundle, { toWebRequest }));     // server/middleware
server.use(ispeakllmForAngular(bundle));                                                // server.ts
```
`markdownAlternateLinks()` (Vue) and `addMarkdownLinks()` (Angular) add the `<link>` tags in the page head.

## Shopify
Shopify serves the storefront, so an App Proxy forwards `/apps/<subpath>/*` to your app. `createShopifyProxyHandler`
verifies the proxy signature with your app secret, picks the shop's bundle and serves it.

## Other languages
WordPress, Laravel, Drupal, Django/Flask, Rack/Rails, Go, Spring and ASP.NET Core: see
[integrations/README.md](../integrations/README.md) for each package, its status and its test command.

## Writing a new adapter
Read the bundle, implement the eight rules in spec/adapter-http, then run:
```bash
node conformance/adapter-http/runner.mjs http://127.0.0.1:<port> --level core
```
Behind the adapter, a test host must answer pass-through requests with `<html>host</html>` (and 404 for paths under
`/no-such-page`).
