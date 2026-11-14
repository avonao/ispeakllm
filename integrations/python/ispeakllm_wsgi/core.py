# New for the IspeakLLM OSS port: Python port of packages/serve/src/index.ts + packages/core/src/negotiate.ts (no Python source in goplainly-v6-2026-11-10-current-dormant)
# SPDX-License-Identifier: MIT
"""Framework-independent IspeakLLM bundle server. Python standard library only.

Request:  ``method``, decoded ``path`` (no query) and a dict of lower-case request headers.
Response: ``(status, [(name, value), ...], body_bytes)`` or ``None`` (let the host app answer).
"""

import hashlib
import json
import math
import re

POLICY_PATHS = ("/robots.txt", "/ai.txt", "/license.xml", "/.well-known/tdmrep.json", "/.well-known/jwks.json")
ACM_PATH = "/.well-known/ai-conformance.json"
ACM_TYPE = "application/ai-conformance+json"
DEFAULT_CACHE_CONTROL = "public, max-age=300"

_Q_RE = re.compile(r"^\s*q\s*=\s*([0-9.]+)\s*$", re.I)
_ACCEPT_WORD = re.compile(r"(^|,)\s*(accept|\*)\s*(,|$)", re.I)  # token match; \baccept\b would match Accept-Encoding


def load_bundle(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def parse_accept(header):
    if not header:
        return []
    out = []
    for index, part in enumerate(header.split(",")):
        pieces = part.split(";")
        typ = pieces[0].strip().lower()
        if not typ:
            continue
        q = 1.0
        for p in pieces[1:]:
            m = _Q_RE.match(p)
            if m:
                try:
                    q = min(1.0, max(0.0, float(m.group(1))))
                except ValueError:
                    q = 0.0
        out.append({"type": typ, "q": q, "index": index})
    return out


def negotiate(path, accept):
    """Port of @ispeakllm/core negotiate() (without locales). Returns (variant, page_path)."""
    if path == ACM_PATH:
        return "acm", None
    if path == "/llms.txt":
        return "llmstxt", None
    if path == "/llms-full.txt":
        return "llmsfull", None
    if path.endswith(".md"):
        page = path[:-3]
        if page in ("", "/index"):
            page = "/"
        elif page.endswith("/index"):
            page = page[:-6] or "/"
        return "md", page

    entries = parse_accept(accept)

    def find(t):
        for e in entries:
            if e["type"] == t:
                return e
        return None

    acm = find(ACM_TYPE)
    md = find("text/markdown")
    html = find("text/html") or find("text/*") or find("*/*")
    cands = []
    if acm and acm["q"] > 0:
        cands.append(("acm", acm["q"], 0, acm["index"]))
    if md and md["q"] > 0:
        cands.append(("md", md["q"], 1, md["index"]))
    if html and html["q"] > 0:
        cands.append(("html", html["q"], 1, html["index"]))
    cands.sort(key=lambda c: (-c[1], c[2], c[3]))
    best = cands[0][0] if cands else None
    if best == "acm":
        return "acm", None
    if best == "md":
        page = path[:-1] if path.endswith("/") and path != "/" else path
        return "md", page
    return "html", None


def link_header_value(pathname, origin=None):
    def ab(p):
        return origin.rstrip("/") + p if origin else p

    p = pathname.rstrip("/") if len(pathname) > 1 else pathname
    md = "/index.md" if p in ("/", "") else p + ".md"
    return '<%s>; rel="alternate"; type="text/markdown", <%s>; rel="describedby"; type="text/markdown"' % (ab(md), ab("/llms.txt"))


def _strip_weak(t):
    t = t.strip()
    return t[2:] if t.startswith("W/") else t


def merge_discovery(headers, add):
    """Merge discovery headers into a list of (name, value) pairs. Vary keeps existing values, Link is extended."""
    out = list(headers)

    def idx(name):
        for i, (k, _) in enumerate(out):
            if k.lower() == name:
                return i
        return -1

    for k, v in add.items():
        i = idx(k)
        if k == "vary":
            cur = out[i][1] if i >= 0 else ""
            if not cur or not _ACCEPT_WORD.search(cur):
                val = cur + ", Accept" if cur else "Accept"
                if i >= 0:
                    out[i] = (out[i][0], val)
                else:
                    out.append(("Vary", val))
        elif k == "link":
            if i >= 0 and out[i][1]:
                out[i] = (out[i][0], out[i][1] + ", " + v)
            else:
                out.append(("Link", v))
        else:
            if i >= 0:
                out[i] = (out[i][0], v)
            else:
                out.append((k, v))
    return out


class BundleServer(object):
    def __init__(self, bundle, cache_control=DEFAULT_CACHE_CONTROL):
        if not isinstance(bundle, dict) or bundle.get("version") != 1 or not isinstance(bundle.get("files"), dict):
            raise ValueError("IspeakLLM: not a version 1 bundle")
        self.bundle = bundle
        self.cache_control = cache_control

    @classmethod
    def from_file(cls, path, cache_control=DEFAULT_CACHE_CONTROL):
        return cls(load_bundle(path), cache_control)

    def _file(self, path):
        f = self.bundle["files"].get(path)
        return f if isinstance(f, dict) else None

    def path_headers_for(self, pathname):
        ph = self.bundle.get("pathHeaders")
        if not isinstance(ph, dict):
            return {}
        best = "/"
        for k in ph:
            if pathname.startswith(k) and len(k) > len(best):
                best = k
        h = ph.get(best)
        return h if isinstance(h, dict) else {}

    def handle(self, method, path, headers):
        method = (method or "GET").upper()
        if method not in ("GET", "HEAD"):
            return None
        head = method == "HEAD"

        if path in POLICY_PATHS:
            f = self._file(path)
            if f:
                return self._res(200, [("Content-Type", f["type"]), ("Cache-Control", self.cache_control)], "" if head else f["body"])

        variant, page = negotiate(path, headers.get("accept"))
        if variant == "acm":
            f = self._file(ACM_PATH)
            if not f:
                return None
            return self._res(200, [("Content-Type", ACM_TYPE), ("Cache-Control", self.cache_control), ("Vary", "Accept")], "" if head else f["body"])
        if variant in ("llmstxt", "llmsfull"):
            f = self._file("/llms.txt" if variant == "llmstxt" else "/llms-full.txt")
            return self._markdown(f, headers, head, "/") if f else None
        if variant == "md":
            page = page or "/"
            f = self._file("/index.md" if page == "/" else page + ".md")
            if f:
                return self._markdown(f, headers, head, page)
            if path.endswith(".md"):
                return self._res(404, [("Content-Type", "text/plain; charset=utf-8"), ("Vary", "Accept")], "" if head else "No Markdown is published for this page.\n")
            return None  # Accept: text/markdown on a page we don't know: the host answers with HTML.
        return None

    def discovery_headers(self, pathname):
        h = {"vary": "Accept"}
        md = "/index.md" if pathname == "/" else pathname.rstrip("/") + ".md"
        if self._file(md):
            h["link"] = link_header_value(pathname, self.bundle.get("origin"))
        for k, v in self.path_headers_for(pathname).items():
            if v:
                h[k.lower()] = v
        return h

    def decorate(self, pathname, headers):
        """Return the host response headers with discovery headers added (HTML responses only)."""
        ctype = ""
        for k, v in headers:
            if k.lower() == "content-type":
                ctype = v
        if "text/html" not in ctype:
            return list(headers)
        return merge_discovery(headers, self.discovery_headers(pathname))

    def _markdown(self, f, req_headers, head, policy_path):
        body = f["body"]
        etag = f.get("etag") or '"%s"' % hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
        tokens = f.get("tokens")
        if tokens is None:
            tokens = int(math.ceil(len(body.encode("utf-8")) / 4.0)) if body else 0
        h = [
            ("Content-Type", f.get("type") or "text/markdown; charset=utf-8"),
            ("Vary", "Accept"),
            ("x-markdown-tokens", str(tokens)),
            ("ETag", etag),
            ("Cache-Control", self.cache_control),
        ]
        for k, v in self.path_headers_for(policy_path).items():
            if v:
                h.append((k.lower(), v))
        inm = req_headers.get("if-none-match")
        if inm is not None:
            tags = [_strip_weak(t) for t in inm.split(",")]
            if "*" in tags or _strip_weak(etag) in tags:
                return self._res(304, h, "")
        return self._res(200, h, "" if head else body)

    @staticmethod
    def _res(status, headers, body):
        return status, headers, body.encode("utf-8")
