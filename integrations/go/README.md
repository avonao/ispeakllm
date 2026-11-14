# IspeakLLM for Go (net/http)

`net/http` middleware that serves your IspeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. HTML responses only gain `Vary: Accept`, `Link` and policy headers (added just before the app's headers are written; nothing is buffered).

Standard library only. Go 1.21+. Licence: MIT.

Ported from the dormant GoPlainly Go middleware; the hosted-API calls were replaced by serving the local bundle.

## Install

```sh
go get github.com/avonao/ispeakllm/integrations/go
```

## Use

```go
import ispeakllm "github.com/avonao/ispeakllm/integrations/go"

b, err := ispeakllm.Load(".ispeakllm/bundle.json")
if err != nil { log.Fatal(err) }
// b.CacheControl = "public, max-age=300" // optional
http.ListenAndServe(":8080", b.Middleware(mux))
```

Works with any router that takes `func(http.Handler) http.Handler` (chi `r.Use(b.Middleware)`, gorilla, echo via `echo.WrapMiddleware`, gin via an adapter). `b.Handle(r)` and `b.Decorate(path, header)` are exported for custom wiring.

## Test

```sh
cd integrations/go && go test ./...
```

`TestConformanceCoreOverHTTP` starts `httptest.NewServer` (127.0.0.1, random port) with the middleware in front of the reference host and runs `conformance/adapter-http/runner.mjs --level core` (needs `node`).
