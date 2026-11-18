# frozen_string_literal: true
# New for the iSpeakLLM OSS port (no Rack/Rails source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
#
# Boots WEBrick (stdlib) on a free 127.0.0.1 port with a minimal Rack bridge, the
# iSpeakLLM middleware and the reference host app, then runs
# conformance/adapter-http/runner.mjs --level core against it. No gems needed.
#
#   ruby integrations/rack/test/conformance_test.rb

require "webrick"
require "stringio"
require_relative "../lib/ispeakllm/rack"

PKG = File.expand_path("..", __dir__)
CONF = File.expand_path("../../conformance/adapter-http", PKG)

# Reference host from cases.json `host`.
HOST_APP = lambda do |env|
  if env["PATH_INFO"].start_with?("/no-such-page")
    [404, { "content-type" => "text/html; charset=utf-8" }, ["<html>missing</html>"]]
  else
    [200, { "content-type" => "text/html; charset=utf-8" }, ["<html>host</html>"]]
  end
end

# Minimal Rack-to-WEBrick bridge (the rack gem's Rack::Handler::WEBrick is not assumed).
class RackServlet < WEBrick::HTTPServlet::AbstractServlet
  def initialize(server, app)
    super(server)
    @app = app
  end

  def service(req, res)
    env = {
      "REQUEST_METHOD" => req.request_method,
      "SCRIPT_NAME" => "",
      "PATH_INFO" => req.request_uri.path.to_s, # still percent-encoded, as in Rack
      "QUERY_STRING" => req.query_string.to_s,
      "SERVER_NAME" => "127.0.0.1",
      "SERVER_PORT" => req.port.to_s,
      "rack.input" => StringIO.new(req.body.to_s),
      "rack.url_scheme" => "http"
    }
    req.each { |k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
    status, headers, body = @app.call(env)
    res.status = status
    headers.each { |k, v| res[k] = v }
    out = +""
    body.each { |chunk| out << chunk }
    body.close if body.respond_to?(:close)
    res.body = out
  end
end

app = IspeakLLM::Rack::Middleware.new(HOST_APP, bundle_path: File.join(CONF, "bundle.json"))
server = WEBrick::HTTPServer.new(BindAddress: "127.0.0.1", Port: 0, Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
server.mount("/", RackServlet, app)
port = server.config[:Port]
thread = Thread.new { server.start }
begin
  ok = system("node", File.join(CONF, "runner.mjs"), "http://127.0.0.1:#{port}", "--level", "core")
ensure
  server.shutdown
  thread.join
end
exit(ok ? 0 : 1)
