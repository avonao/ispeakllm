# Example: a basic site

```bash
npx ispeakllm generate     # writes public/ and .ispeakllm/bundle.json
npx ispeakllm serve        # http://127.0.0.1:4321
curl -H 'Accept: text/markdown' http://127.0.0.1:4321/docs/quickstart
```

Optional signing: `npx ispeakllm keys`, then `generate` again. The AI Conformance Manifest is then signed
and `public/.well-known/jwks.json` holds the public key. Keep `.ispeakllm/signing-key.json` out of git.

Use the bundle with any adapter: `adapters/edge-worker/template` (Cloudflare Worker in front of any host)
or `@ispeakllm/next` (Next.js middleware).
