# Server-side framework integrations

Thin, dependency-light ports that serve an IspeakLLM **bundle** (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters in `adapters/` (reference: `packages/serve/src/index.ts`, negotiation: `packages/core/src/negotiate.ts`). The spec is `conformance/adapter-http/cases.json`; every port passes the `core` level. MCP (`full` level) is not part of these ports.

| Integration | Folder | Runtime deps | Core conformance | Test (from the repo root) |
| --- | --- | --- | --- | --- |
| WordPress plugin | `wordpress/` | none | 19/19 | `php integrations/wordpress/tests/conformance.php` |
| Laravel package | `laravel/` | Laravel | 19/19 (PHP core) | `php integrations/laravel/tests/conformance.php` |
| Drupal module | `drupal/` | Drupal core | 19/19 (PHP core) | `php integrations/drupal/tests/conformance.php` |
| Python: WSGI, Django, Flask | `python/` | none (stdlib) | 19/19 (WSGI) | `python3 -m unittest discover -s integrations/python/tests` |
| Rack / Rails | `rack/` | none (stdlib) | 19/19 | `ruby integrations/rack/test/conformance_test.rb` |
| Go `net/http` | `go/` | none (stdlib) | 19/19 | `(cd integrations/go && go test ./...)` |
| Spring Boot | `spring/` | Spring Web, Jackson (host app's) | NOTRUN (no JVM here) | `(cd integrations/spring && mvn test)` |
| ASP.NET Core | `aspnetcore/` | shared framework | NOTRUN (no .NET SDK here) | `(cd integrations/aspnetcore && dotnet test tests/IspeakLLM.AspNetCore.Tests)` |

Every runnable test boots a real server on a free `127.0.0.1` port with the integration in front of the reference host from `cases.json` (`host`), runs `node conformance/adapter-http/runner.mjs <url> --level core`, and shuts the server down. Node is needed for the runner. Spring and ASP.NET Core run the same `core` cases in-process (MockMvc, TestServer) with the runner's checks.

The PHP integrations share one framework-independent core, `core/BundleServer.php` (array in, array out). Each package ships its own identical copy so it installs on its own; every PHP test fails if the copies differ. The framework glue (WordPress hooks, Laravel middleware and service provider, Drupal HTTP middleware, Django/Flask wrappers, Railtie) is thin and is not exercised by these tests, because the frameworks are not installed here.

## Behaviour (all ports)

GET and HEAD only; other methods pass through.

1. Policy files in the bundle (`/robots.txt`, `/ai.txt`, `/license.xml`, `/.well-known/tdmrep.json`, `/.well-known/jwks.json`) are served with the file's `type`.
2. `/.well-known/ai-conformance.json` (or `Accept: application/ai-conformance+json`): `application/ai-conformance+json`, `Vary: Accept`.
3. `llms.txt`, `llms-full.txt`, `/x.md`, and `/x` or `/x/` with `Accept: text/markdown` winning by q (home is `/index.md`): bundle body, `etag` and `x-markdown-tokens` from the bundle, `vary: Accept`, `cache-control: public, max-age=300`, and the policy headers from `pathHeaders` (longest prefix). `If-None-Match` (`*`, lists, `W/` ignored) gives 304.
4. Unknown `*.md` gives 404 `text/plain`; an unknown page asked for as Markdown via `Accept` passes through to the app.
5. HTML from the app: `Vary` gains `Accept` (existing values kept), `Link: <…/x.md>; rel="alternate"; type="text/markdown", <…/llms.txt>; rel="describedby"; type="text/markdown"` when the page's Markdown exists (absolute with the bundle's `origin`), and the policy headers. The body is never touched.

`Vary` is checked token by token, so `Vary: Accept-Encoding` still gets `, Accept` (same as `varyWithAccept` in `packages/serve`).

Other integrations in this folder (`shopify/`, `vue/`, `svelte/`, `angular/`) are maintained separately.
