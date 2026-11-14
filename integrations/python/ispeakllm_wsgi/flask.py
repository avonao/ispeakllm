# New for the IspeakLLM OSS port (no Flask source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""Flask glue. Flask is not imported: the WSGI middleware wraps ``app.wsgi_app``.

    from ispeakllm_wsgi.flask import init_app
    init_app(app)  # reads app.config["ISPEAKLLM_BUNDLE"], default ".ispeakllm/bundle.json"
"""

from .core import DEFAULT_CACHE_CONTROL
from .wsgi import IspeakLLMMiddleware


def init_app(app, bundle_path=None):
    path = bundle_path or app.config.get("ISPEAKLLM_BUNDLE", ".ispeakllm/bundle.json")
    cache = app.config.get("ISPEAKLLM_CACHE_CONTROL", DEFAULT_CACHE_CONTROL)
    app.wsgi_app = IspeakLLMMiddleware(app.wsgi_app, bundle_path=path, cache_control=cache)
    return app
