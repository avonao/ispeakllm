# frozen_string_literal: true
# New for the iSpeakLLM OSS port (no Rack/Rails source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT

require_relative "rack/bundle_server"
require_relative "rack/middleware"
require_relative "rack/railtie" if defined?(::Rails::Railtie)

module IspeakLLM
  module Rack
    VERSION = "0.1.0"
  end
end
