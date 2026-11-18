# New for the iSpeakLLM OSS port (no Django source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""Django middleware. Add near the top of MIDDLEWARE::

    MIDDLEWARE = ["ispeakllm_wsgi.django.IspeakLLMMiddleware", ...]
    ISPEAKLLM_BUNDLE = BASE_DIR / ".ispeakllm" / "bundle.json"   # default: ".ispeakllm/bundle.json"
    ISPEAKLLM_CACHE_CONTROL = "public, max-age=300"              # optional

(Wrapping the WSGI application with ``ispeakllm_wsgi.wsgi.IspeakLLMMiddleware`` in wsgi.py also works.)
"""

from django.conf import settings
from django.http import HttpResponse

from .core import BundleServer, DEFAULT_CACHE_CONTROL


class IspeakLLMMiddleware(object):
    def __init__(self, get_response):
        self.get_response = get_response
        self.server = BundleServer.from_file(
            str(getattr(settings, "ISPEAKLLM_BUNDLE", ".ispeakllm/bundle.json")),
            getattr(settings, "ISPEAKLLM_CACHE_CONTROL", DEFAULT_CACHE_CONTROL),
        )

    def __call__(self, request):
        path = request.path  # decoded, includes SCRIPT_NAME
        headers = {k.lower(): v for k, v in request.headers.items()}
        res = self.server.handle(request.method, path, headers)
        if res is not None:
            status, hdrs, body = res
            response = HttpResponse(body, status=status)
            for k, v in hdrs:
                response[k] = v
            return response

        response = self.get_response(request)
        current = [(k, response[k]) for k in ("Content-Type", "Vary", "Link") if response.has_header(k)]
        for k, v in self.server.decorate(path, current):
            if k.lower() != "content-type":
                response[k] = v
        return response
