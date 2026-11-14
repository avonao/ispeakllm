# IspeakLLM for Spring Boot

A servlet filter (auto-configured) that serves your IspeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. HTML responses only gain `Vary: Accept`, `Link` and policy headers, applied when the HTML content type is set (no buffering).

Spring Boot 3 / Java 17. No dependencies beyond what a Spring Boot web app already has (Spring Web, Jackson). Licence: MIT.

Ported from the dormant GoPlainly Spring starter; the proxying controller was replaced by a filter serving the local bundle.

## Install

```xml
<dependency>
  <groupId>io.github.avonao</groupId>
  <artifactId>ispeakllm-spring</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Configure (application.properties)

```properties
ispeakllm.bundle=.ispeakllm/bundle.json
ispeakllm.cache-control=public, max-age=300
ispeakllm.enabled=true
```

`IspeakLLMAutoConfiguration` registers `IspeakLLMFilter` for `/*` near the top of the filter chain. Without Boot, construct `new IspeakLLMFilter(BundleServer.fromFile(path, null))` and register it yourself.

## Test

```sh
cd integrations/spring && mvn test
```

`IspeakLLMFilterConformanceTest` runs every `core` case from `conformance/adapter-http/cases.json` through MockMvc (filter + reference host controller) with the same checks as `runner.mjs`.

Status: **NOTRUN** — written without a Java runtime available; not compiled or run yet.
