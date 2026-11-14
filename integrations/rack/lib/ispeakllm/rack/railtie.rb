# frozen_string_literal: true
# New for the IspeakLLM OSS port (no Rails source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT

module IspeakLLM
  module Rack
    # Rails: inserts the middleware at the top of the stack.
    #
    #   # config/application.rb (optional; defaults shown)
    #   config.ispeakllm.bundle_path = Rails.root.join(".ispeakllm/bundle.json")
    #   config.ispeakllm.enabled = true
    class Railtie < ::Rails::Railtie
      config.ispeakllm = ActiveSupport::OrderedOptions.new
      config.ispeakllm.enabled = true

      initializer "ispeakllm.middleware" do |app|
        opts = app.config.ispeakllm
        path = opts.bundle_path || app.root.join(".ispeakllm", "bundle.json")
        if opts.enabled && File.file?(path.to_s)
          app.middleware.insert_before(0, IspeakLLM::Rack::Middleware, bundle_path: path.to_s,
                                                                       cache_control: opts.cache_control || BundleServer::DEFAULT_CACHE_CONTROL)
        end
      end
    end
  end
end
