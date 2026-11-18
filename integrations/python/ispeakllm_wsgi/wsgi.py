# New for the iSpeakLLM OSS port (no Python source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""WSGI middleware: any WSGI app (Flask, Django, Pyramid, Bottle, ...)."""

from .core import BundleServer, DEFAULT_CACHE_CONTROL

_REASONS = {200: "OK", 304: "Not Modified", 404: "Not Found"}


def request_path(environ):
    raw = environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "")
    # PEP 3333: the decoded path arrives as latin-1 text; recover the UTF-8 string.
    try:
        raw = raw.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return raw or "/"


def request_headers(environ):
    h = {}
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            h[k[5:].replace("_", "-").lower()] = v
    return h


class IspeakLLMMiddleware(object):
    """Wrap a WSGI app::

        app = IspeakLLMMiddleware(app, bundle_path=".ispeakllm/bundle.json")
    """

    def __init__(self, app, bundle_path=None, bundle=None, cache_control=DEFAULT_CACHE_CONTROL):
        self.app = app
        if bundle is None and bundle_path is None:
            raise ValueError("iSpeakLLM: pass bundle_path or bundle")
        self.server = BundleServer(bundle, cache_control) if bundle is not None else BundleServer.from_file(bundle_path, cache_control)

    def __call__(self, environ, start_response):
        path = request_path(environ)
        res = self.server.handle(environ.get("REQUEST_METHOD", "GET"), path, request_headers(environ))
        if res is not None:
            status, headers, body = res
            start_response("%d %s" % (status, _REASONS.get(status, "")), headers)
            return [body]

        server = self.server

        def decorating_start_response(status, headers, exc_info=None):
            return start_response(status, server.decorate(path, headers), exc_info) if exc_info else start_response(status, server.decorate(path, headers))

        return self.app(environ, decorating_start_response)
