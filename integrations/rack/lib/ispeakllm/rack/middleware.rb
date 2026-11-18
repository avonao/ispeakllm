# frozen_string_literal: true
# New for the iSpeakLLM OSS port (no Rack/Rails source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT

require "uri"
require_relative "bundle_server"

module IspeakLLM
  module Rack
    # Plain Rack middleware (Rack 2 and 3; no rack gem needed at runtime).
    #
    #   use IspeakLLM::Rack::Middleware, bundle_path: ".ispeakllm/bundle.json"
    class Middleware
      def initialize(app, bundle_path: ".ispeakllm/bundle.json", bundle: nil, cache_control: BundleServer::DEFAULT_CACHE_CONTROL)
        @app = app
        @server = bundle ? BundleServer.new(bundle, cache_control: cache_control) : BundleServer.from_file(bundle_path.to_s, cache_control: cache_control)
      end

      def call(env)
        path = request_path(env)
        res = @server.handle(env["REQUEST_METHOD"], path, request_headers(env))
        return [res[0], res[1], [res[2]]] if res

        status, headers, body = @app.call(env)
        [status, @server.decorate(path, headers), body]
      end

      private

      def request_path(env)
        raw = "#{env['SCRIPT_NAME']}#{env['PATH_INFO']}"
        raw = "/" if raw.empty?
        URI.decode_www_form_component(raw.gsub("+", "%2B")).force_encoding("UTF-8")
      rescue ArgumentError
        raw
      end

      def request_headers(env)
        h = {}
        env.each { |k, v| h[k[5..-1].tr("_", "-").downcase] = v if k.start_with?("HTTP_") && v.is_a?(String) }
        h
      end
    end
  end
end
