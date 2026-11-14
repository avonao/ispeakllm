# Adapter HTTP behaviour v1

What every IspeakLLM adapter does, in any language. The normative test is
[conformance/adapter-http/cases.json](../../conformance/adapter-http/cases.json): an adapter conforms at level
**core** when it passes every `core` case, and at level **full** when it also passes the MCP cases.

```bash
node conformance/adapter-http/runner.mjs http://127.0.0.1:8080 --level core
```

## Rules
1. **Only GET and HEAD** are answered (plus POST to the MCP endpoint at level full). Everything else goes to the app.
2. **Explicit paths first**: `/.well-known/ai-conformance.json` (ACM), `/llms.txt`, `/llms-full.txt`, and any path
   ending in `.md` (`/index.md` and `/x/index.md` mean the directory page).
3. **Then `Accept`**: if an explicit `text/markdown` has a higher q than any HTML match (`text/html`,
   `application/xhtml+xml`, `*/*`), the page's Markdown is served. Equal q prefers the one listed first; `q=0` excludes.
   A trailing slash is ignored; `/` maps to `/index.md`.
4. **Markdown responses** carry the file's `content-type`, `vary: Accept`, `etag`, `x-markdown-tokens`,
   `cache-control: public, max-age=300` and the policy headers for the path (`pathHeaders`, longest prefix).
   `If-None-Match` matching the ETag (or `*`; weak prefixes ignored) gives `304` with no body.
5. **Unknown `.md`** gives 404. An `Accept`-negotiated page that is not in the bundle goes to the app (or, in the
   Worker with an upstream, to the html-md fallback, marked `x-ispeakllm-source: html-fallback`).
6. **Policy files** (`/robots.txt`, `/ai.txt`, `/license.xml`, `/.well-known/tdmrep.json`, `/.well-known/jwks.json`)
   are served from the bundle when present.
7. **Human HTML is never changed.** The app's response only gains `vary: Accept` (appended), a `link` header to the
   page's Markdown and to `/llms.txt` when the Markdown exists, and the policy headers.
8. **MCP (full level)**: `POST /mcp` speaks JSON-RPC 2.0 over streamable HTTP (protocol `2025-06-18`), read-only tools
   `search`, `get_page`, `get_policy`, `get_manifest`; `/.well-known/mcp.json` is the server card.
