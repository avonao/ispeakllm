# frozen_string_literal: true
# New for the IspeakLLM OSS port: Ruby port of packages/serve/src/index.ts + packages/core/src/negotiate.ts (no Ruby source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT

require "json"
require "digest"

module IspeakLLM
  module Rack
    # Framework-independent bundle server. Ruby standard library only.
    class BundleServer
      POLICY_PATHS = ["/robots.txt", "/ai.txt", "/license.xml", "/.well-known/tdmrep.json", "/.well-known/jwks.json"].freeze
      ACM_PATH = "/.well-known/ai-conformance.json"
      ACM_TYPE = "application/ai-conformance+json"
      DEFAULT_CACHE_CONTROL = "public, max-age=300"
      Q_RE = /\A\s*q\s*=\s*([0-9.]+)\s*\z/i.freeze

      attr_reader :bundle

      def self.from_file(path, cache_control: DEFAULT_CACHE_CONTROL)
        new(JSON.parse(File.read(path, encoding: "UTF-8")), cache_control: cache_control)
      end

      def initialize(bundle, cache_control: DEFAULT_CACHE_CONTROL)
        raise ArgumentError, "IspeakLLM: not a version 1 bundle" unless bundle.is_a?(Hash) && bundle["version"] == 1 && bundle["files"].is_a?(Hash)

        @bundle = bundle
        @cache_control = cache_control
      end

      # @param headers [Hash] lower-case request header names
      # @return [Array(Integer, Hash, String), nil] status, lower-case headers, body; nil = let the app answer
      def handle(method, path, headers)
        method = (method || "GET").upcase
        return nil unless %w[GET HEAD].include?(method)

        head = method == "HEAD"
        if POLICY_PATHS.include?(path) && (f = file(path))
          return [200, { "content-type" => f["type"], "cache-control" => @cache_control }, head ? "" : f["body"]]
        end

        variant, page = self.class.negotiate(path, headers["accept"])
        case variant
        when "acm"
          f = file(ACM_PATH)
          return nil unless f

          [200, { "content-type" => ACM_TYPE, "cache-control" => @cache_control, "vary" => "Accept" }, head ? "" : f["body"]]
        when "llmstxt", "llmsfull"
          f = file(variant == "llmstxt" ? "/llms.txt" : "/llms-full.txt")
          f ? markdown(f, headers, head, "/") : nil
        when "md"
          page ||= "/"
          f = file(page == "/" ? "/index.md" : "#{page}.md")
          return markdown(f, headers, head, page) if f
          return [404, { "content-type" => "text/plain; charset=utf-8", "vary" => "Accept" }, head ? "" : "No Markdown is published for this page.\n"] if path.end_with?(".md")

          nil # Accept: text/markdown on a page we don't know: the app answers with HTML.
        end
      end

      def discovery_headers(pathname)
        h = { "vary" => "Accept" }
        md = pathname == "/" ? "/index.md" : "#{pathname.sub(%r{/+\z}, '')}.md"
        h["link"] = self.class.link_header_value(pathname, @bundle["origin"]) if file(md)
        path_headers_for(pathname).each { |k, v| h[k.downcase] = v if v && !v.empty? }
        h
      end

      # Merge discovery headers into a host response header hash (mutates and returns it).
      # Header names are matched case-insensitively (Rack 2 apps may use "Content-Type").
      def decorate(pathname, headers)
        ctype = lookup(headers, "content-type")
        return headers unless ctype && ctype.to_s.include?("text/html")

        discovery_headers(pathname).each do |k, v|
          key = headers.keys.find { |hk| hk.to_s.downcase == k } || k
          cur = headers[key].to_s
          case k
          when "vary"
            headers[key] = cur.empty? ? "Accept" : "#{cur}, Accept" unless cur =~ /(?:\A|,)\s*(?:accept|\*)\s*(?:,|\z)/i
          when "link"
            headers[key] = cur.empty? ? v : "#{cur}, #{v}"
          else
            headers[key] = v
          end
        end
        headers
      end

      def path_headers_for(pathname)
        ph = @bundle["pathHeaders"]
        return {} unless ph.is_a?(Hash)

        best = "/"
        ph.each_key { |k| best = k if pathname.start_with?(k) && k.length > best.length }
        ph[best].is_a?(Hash) ? ph[best] : {}
      end

      def self.parse_accept(header)
        return [] if header.nil? || header.empty?

        out = []
        header.split(",", -1).each_with_index do |part, index|
          type, *params = part.split(";", -1)
          type = type.to_s.strip.downcase
          next if type.empty?

          q = 1.0
          params.each do |p|
            m = Q_RE.match(p)
            next unless m

            q = m[1] =~ /\A(\d+\.?\d*|\.\d+)\z/ ? [[m[1].to_f, 0.0].max, 1.0].min : 0.0
          end
          out << { type: type, q: q, index: index }
        end
        out
      end

      # Port of @ispeakllm/core negotiate() (without locales). Returns [variant, page_path].
      def self.negotiate(path, accept)
        return ["acm", nil] if path == ACM_PATH
        return ["llmstxt", nil] if path == "/llms.txt"
        return ["llmsfull", nil] if path == "/llms-full.txt"

        if path.end_with?(".md")
          page = path[0...-3]
          if page == "" || page == "/index"
            page = "/"
          elsif page.end_with?("/index")
            page = page[0...-6]
            page = "/" if page.empty?
          end
          return ["md", page]
        end

        entries = parse_accept(accept)
        find = ->(t) { entries.find { |e| e[:type] == t } }
        acm = find.call(ACM_TYPE)
        md = find.call("text/markdown")
        html = find.call("text/html") || find.call("text/*") || find.call("*/*")
        cands = []
        cands << ["acm", acm[:q], 0, acm[:index]] if acm && acm[:q] > 0
        cands << ["md", md[:q], 1, md[:index]] if md && md[:q] > 0
        cands << ["html", html[:q], 1, html[:index]] if html && html[:q] > 0
        best = cands.min_by { |c| [-c[1], c[2], c[3]] }
        return ["acm", nil] if best && best[0] == "acm"
        return ["md", path.end_with?("/") && path != "/" ? path[0...-1] : path] if best && best[0] == "md"

        ["html", nil]
      end

      def self.link_header_value(pathname, origin = nil)
        abs = ->(p) { origin ? origin.sub(%r{/+\z}, "") + p : p }
        p = pathname.length > 1 ? pathname.sub(%r{/+\z}, "") : pathname
        md = p == "/" || p.empty? ? "/index.md" : "#{p}.md"
        %(<#{abs.call(md)}>; rel="alternate"; type="text/markdown", <#{abs.call('/llms.txt')}>; rel="describedby"; type="text/markdown")
      end

      private

      def file(path)
        f = @bundle["files"][path]
        f.is_a?(Hash) ? f : nil
      end

      def lookup(headers, name)
        key = headers.keys.find { |k| k.to_s.downcase == name }
        key ? headers[key] : nil
      end

      def strip_weak(t)
        t.strip.sub(%r{\AW/}, "")
      end

      def markdown(f, req_headers, head, policy_path)
        body = f["body"]
        etag = f["etag"] || %("#{Digest::SHA256.hexdigest(body)[0, 32]}")
        tokens = f["tokens"] || (body.empty? ? 0 : (body.bytesize / 4.0).ceil)
        h = {
          "content-type" => f["type"] || "text/markdown; charset=utf-8",
          "vary" => "Accept",
          "x-markdown-tokens" => tokens.to_s,
          "etag" => etag,
          "cache-control" => @cache_control
        }
        path_headers_for(policy_path).each { |k, v| h[k.downcase] = v if v && !v.empty? }
        inm = req_headers["if-none-match"]
        if inm
          tags = inm.split(",").map { |t| strip_weak(t) }
          return [304, h, ""] if tags.include?("*") || tags.include?(strip_weak(etag))
        end
        [200, h, head ? "" : body]
      end
    end
  end
end
