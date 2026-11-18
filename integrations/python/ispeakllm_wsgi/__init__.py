# New for the iSpeakLLM OSS port (no Python source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""Serve an iSpeakLLM bundle from any WSGI app, Django or Flask. Standard library only."""

from .core import BundleServer, load_bundle, negotiate, parse_accept, link_header_value
from .wsgi import IspeakLLMMiddleware

__all__ = ["BundleServer", "IspeakLLMMiddleware", "load_bundle", "negotiate", "parse_accept", "link_header_value"]
__version__ = "0.1.0"
