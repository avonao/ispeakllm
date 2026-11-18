# iSpeakLLM for ASP.NET Core

Middleware that serves your iSpeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. HTML responses only gain `Vary: Accept`, `Link` and policy headers (in `OnStarting`, no buffering).

.NET 8, shared framework only (`Microsoft.AspNetCore.App`, System.Text.Json); no NuGet runtime dependencies. Licence: MIT.

Ported from the dormant GoPlainly ASP.NET Core package; the proxying controller was replaced by middleware serving the local bundle.

## Install

```sh
dotnet add package IspeakLLM.AspNetCore
```

## Use

```csharp
builder.Services.AddIspeakLLM(o => o.BundlePath = ".ispeakllm/bundle.json"); // or appsettings "iSpeakLLM": { "BundlePath": ..., "CacheControl": ... }
var app = builder.Build();
app.UseIspeakLLM();   // early: before UseStaticFiles and routing
```

## Test

```sh
cd integrations/aspnetcore && dotnet test tests/IspeakLLM.AspNetCore.Tests
```

`ConformanceTests` runs every `core` case from `conformance/adapter-http/cases.json` against `TestServer` (`UseIspeakLLM()` + the reference host) with the same checks as `runner.mjs`.

Status: **NOTRUN** — written without a .NET SDK available; not compiled or run yet.
