# New for the iSpeakLLM OSS port (no Python source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""Boot wsgiref on a free 127.0.0.1 port with IspeakLLMMiddleware + the reference host app and
run conformance/adapter-http/runner.mjs --level core against it.

    python3 -m unittest discover -s integrations/python/tests
"""

import os
import subprocess
import sys
import threading
import unittest
from wsgiref.simple_server import WSGIRequestHandler, make_server

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(PKG))
CONF = os.path.join(REPO, "conformance", "adapter-http")
sys.path.insert(0, PKG)

from ispeakllm_wsgi import IspeakLLMMiddleware, negotiate  # noqa: E402


def host_app(environ, start_response):
    """Reference host from cases.json `host`."""
    path = environ.get("PATH_INFO", "/")
    if path.startswith("/no-such-page"):
        start_response("404 Not Found", [("Content-Type", "text/html; charset=utf-8")])
        return [b"<html>missing</html>"]
    start_response("200 OK", [("Content-Type", "text/html; charset=utf-8")])
    return [b"<html>host</html>"]


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class ConformanceTest(unittest.TestCase):
    def test_core_conformance_over_http(self):
        app = IspeakLLMMiddleware(host_app, bundle_path=os.path.join(CONF, "bundle.json"))
        httpd = make_server("127.0.0.1", 0, app, handler_class=QuietHandler)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            base = "http://127.0.0.1:%d" % httpd.server_address[1]
            out = subprocess.run(["node", os.path.join(CONF, "runner.mjs"), base, "--level", "core"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=120)
            sys.stdout.write(out.stdout)
            self.assertEqual(out.returncode, 0, out.stdout)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_negotiation_ties_prefer_first_listed(self):
        self.assertEqual(negotiate("/x", "text/markdown, text/html")[0], "md")
        self.assertEqual(negotiate("/x", "text/html, text/markdown")[0], "html")
        self.assertEqual(negotiate("/x", "*/*")[0], "html")
        self.assertEqual(negotiate("/docs/index.md", None), ("md", "/docs"))


if __name__ == "__main__":
    unittest.main()
