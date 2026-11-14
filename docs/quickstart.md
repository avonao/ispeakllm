# Quickstart

Requires Node.js 20 or newer.

## 1. Build the CLI
```bash
npm install
npm run build          # writes packages/cli/dist/ispeakllm.mjs
alias ispeakllm="node $PWD/packages/cli/dist/ispeakllm.mjs"
```

## 2. Start a site
```bash
mkdir my-site && cd my-site
ispeakllm init         # ispeakllm.config.json + content/index.md
```
Write pages as Markdown in `content/`. Frontmatter is optional: `title`, `summary`, `section`, `priority`,
`optional: true` (goes to `## Optional`) and `audience`.

## 3. Generate
```bash
ispeakllm generate
```
This writes `public/llms.txt`, `public/llms-full.txt`, a `.md` for every page, `public/.well-known/ai-conformance.json`,
and `.ispeakllm/bundle.json` for the adapters. It also lints the llms.txt it wrote.

## 4. Declare your AI-use terms (optional)
Create `declaration.json` ([spec](../spec/declaration/README.md)) and set `"policy": "declaration.json"` in the config:
```json
{ "domain": "example.com", "defaults": [
  { "subject": "index", "stance": "allow" },
  { "subject": "train", "stance": "deny" } ] }
```
`generate` then writes robots.txt (or `robots.ispeakllm.txt` beside an existing one, for you to merge), ai.txt,
RSL and TDMRep, and every Markdown response carries the matching `Content-Signal` and `Content-Usage` headers.

## 5. Sign (optional)
```bash
ispeakllm keys         # .ispeakllm/signing-key.json, mode 600: never commit it
ispeakllm generate     # the manifest is now signed; public/.well-known/jwks.json holds the public key
ispeakllm verify public/.well-known/ai-conformance.json --jwks public/.well-known/jwks.json
```

## 6. Serve and try
```bash
ispeakllm serve                                   # http://127.0.0.1:4321
curl -H 'Accept: text/markdown' http://127.0.0.1:4321/
curl http://127.0.0.1:4321/llms.txt
```
For production, pick an adapter: [adapters.md](adapters.md).

## 7. Check any site
```bash
ispeakllm lint https://example.com/llms.txt
ispeakllm check https://example.com
```
