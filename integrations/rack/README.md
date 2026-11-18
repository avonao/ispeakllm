# iSpeakLLM for Rack and Rails

Rack middleware that serves your iSpeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. HTML responses only gain `Vary: Accept`, `Link` and policy headers.

Ruby standard library only (2.6+), no runtime gems (not even `rack`). Works with Rack 2 and 3. Licence: MIT.

Written new for the OSS release: the GoPlainly versions had no Ruby source.

## Install

```ruby
gem "ispeakllm-rack"
```

## Rack (Sinatra, Hanami, Roda, plain config.ru)

```ruby
require "ispeakllm/rack"
use IspeakLLM::Rack::Middleware, bundle_path: ".ispeakllm/bundle.json"
```

Options: `bundle_path:` or `bundle:` (a parsed Hash), `cache_control:` (default `public, max-age=300`).

## Rails

The Railtie inserts the middleware at the top of the stack when `Rails.root/.ispeakllm/bundle.json` exists. To configure:

```ruby
# config/application.rb
config.ispeakllm.bundle_path = Rails.root.join("config/ispeakllm/bundle.json")
config.ispeakllm.cache_control = "public, max-age=300"
config.ispeakllm.enabled = true
```

## Test

```sh
ruby integrations/rack/test/conformance_test.rb
```

Boots WEBrick (stdlib) on a free 127.0.0.1 port with a minimal Rack bridge, the middleware and the reference host, then runs `conformance/adapter-http/runner.mjs --level core`. The Railtie needs Rails and is not exercised.
