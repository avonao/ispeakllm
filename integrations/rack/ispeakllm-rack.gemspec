# frozen_string_literal: true
# New for the IspeakLLM OSS port (no Rack/Rails source in goplainly-v6-2026-11-10-current-dormant)

Gem::Specification.new do |s|
  s.name = "ispeakllm-rack"
  s.version = "0.1.0"
  s.summary = "Serve an IspeakLLM bundle from any Rack app (Rails, Sinatra, Hanami)."
  s.description = "Rack middleware serving llms.txt, page Markdown, the AI Conformance Manifest, policy files and headers from an IspeakLLM bundle. No runtime dependencies."
  s.license = "MIT"
  s.authors = ["IspeakLLM contributors"]
  s.files = Dir["lib/**/*.rb", "README.md"]
  s.require_paths = ["lib"]
  s.required_ruby_version = ">= 2.6"
end
