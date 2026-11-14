# IspeakLLM specifications

| Spec | What it defines | Schema |
|---|---|---|
| [declaration](declaration/README.md) | The AI-use declaration and how it projects into Content-Signal, AIPREF, robots.txt, RSL, ai.txt and TDM | [declaration.schema.json](declaration/declaration.schema.json) |
| [acm](acm/README.md) | AI Conformance Manifest v1 at `/.well-known/ai-conformance.json` | [acm.schema.json](acm/acm.schema.json) |
| [signing](signing/README.md) | Signing profile: JCS (RFC 8785), Ed25519, content ids, JWKS, detached signatures | — |
| [llms-txt-extensions](llms-txt-extensions/README.md) | Per-page Markdown, languages, audience views, context export | — |
| [bundle](bundle/README.md) | The adapter bundle every runtime serves | [bundle.schema.json](bundle/bundle.schema.json) |
| [adapter-http](adapter-http/README.md) | The HTTP behaviour every adapter must show | conformance cases |
| [fetch-log](fetch-log/README.md) | `ispeakllm.fetch/1` records and identity grades | [fetch-log.schema.json](fetch-log/fetch-log.schema.json) |

Every schema is checked against the fixtures in `conformance/` by `packages/serve/test/specs.test.ts`.
