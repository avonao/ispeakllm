// Ported from integrations/go-middleware/llmstxt.go (goplainly-v6-2026-11-10-current-dormant); behaviour from packages/serve/src/index.ts
// SPDX-License-Identifier: MIT

// Package ispeakllm serves an IspeakLLM bundle (`ispeakllm generate` writes
// .ispeakllm/bundle.json) as net/http middleware: llms.txt, llms-full.txt, page
// Markdown (`/x.md` and `Accept: text/markdown`), conditional 304, the AI
// Conformance Manifest, policy files and per-path policy headers. Human HTML only
// gains Vary, Link and policy headers. Standard library only.
//
//	b, err := ispeakllm.Load(".ispeakllm/bundle.json")
//	http.ListenAndServe(":8080", b.Middleware(mux))
package ispeakllm

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// DefaultCacheControl is sent on Markdown, llms.txt, the ACM and policy files.
const DefaultCacheControl = "public, max-age=300"

var policyPaths = map[string]bool{"/robots.txt": true, "/ai.txt": true, "/license.xml": true, "/.well-known/tdmrep.json": true, "/.well-known/jwks.json": true}

// File is one bundle entry.
type File struct {
	Type   string `json:"type"`
	Body   string `json:"body"`
	ETag   string `json:"etag,omitempty"`
	Tokens *int   `json:"tokens,omitempty"`
}

// Bundle is the subset of the bundle format a server needs.
type Bundle struct {
	Version     int                          `json:"version"`
	Origin      string                       `json:"origin,omitempty"`
	Files       map[string]File              `json:"files"`
	PathHeaders map[string]map[string]string `json:"pathHeaders,omitempty"`

	// CacheControl overrides DefaultCacheControl when set.
	CacheControl string `json:"-"`
}

// Load reads and validates a bundle file.
func Load(path string) (*Bundle, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ispeakllm: %w", err)
	}
	return Parse(raw)
}

// Parse decodes a bundle.
func Parse(raw []byte) (*Bundle, error) {
	var b Bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("ispeakllm: %w", err)
	}
	if b.Version != 1 || b.Files == nil {
		return nil, errors.New("ispeakllm: not a version 1 bundle")
	}
	return &b, nil
}

func (b *Bundle) cacheControl() string {
	if b.CacheControl != "" {
		return b.CacheControl
	}
	return DefaultCacheControl
}

func (b *Bundle) file(p string) (File, bool) {
	f, ok := b.Files[p]
	return f, ok
}

// PathHeadersFor returns the policy headers of the longest pathHeaders key prefixing pathname ("/" by default).
func (b *Bundle) PathHeadersFor(pathname string) map[string]string {
	best := "/"
	for k := range b.PathHeaders {
		if strings.HasPrefix(pathname, k) && len(k) > len(best) {
			best = k
		}
	}
	return b.PathHeaders[best]
}

// Response is a bundle answer.
type Response struct {
	Status int
	Header http.Header
	Body   string
}

// Handle answers r from the bundle, or returns nil to let the app answer.
func (b *Bundle) Handle(r *http.Request) *Response {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return nil
	}
	path := r.URL.Path // decoded by net/url
	if path == "" {
		path = "/"
	}
	head := r.Method == http.MethodHead
	body := func(s string) string {
		if head {
			return ""
		}
		return s
	}

	if policyPaths[path] {
		if f, ok := b.file(path); ok {
			h := http.Header{}
			h.Set("Content-Type", f.Type)
			h.Set("Cache-Control", b.cacheControl())
			return &Response{200, h, body(f.Body)}
		}
	}

	variant, page := Negotiate(path, r.Header.Get("Accept"))
	switch variant {
	case "acm":
		f, ok := b.file(ACMPath)
		if !ok {
			return nil
		}
		h := http.Header{}
		h.Set("Content-Type", ACMType)
		h.Set("Cache-Control", b.cacheControl())
		h.Set("Vary", "Accept")
		return &Response{200, h, body(f.Body)}
	case "llmstxt", "llmsfull":
		name := "/llms.txt"
		if variant == "llmsfull" {
			name = "/llms-full.txt"
		}
		if f, ok := b.file(name); ok {
			return b.markdown(f, r, head, "/")
		}
		return nil
	case "md":
		if page == "" {
			page = "/"
		}
		mdPath := page + ".md"
		if page == "/" {
			mdPath = "/index.md"
		}
		if f, ok := b.file(mdPath); ok {
			return b.markdown(f, r, head, page)
		}
		if strings.HasSuffix(path, ".md") {
			h := http.Header{}
			h.Set("Content-Type", "text/plain; charset=utf-8")
			h.Set("Vary", "Accept")
			return &Response{404, h, body("No Markdown is published for this page.\n")}
		}
		return nil // Accept: text/markdown on a page we don't know: the app answers with HTML.
	}
	return nil
}

func stripWeak(t string) string { return strings.TrimPrefix(strings.TrimSpace(t), "W/") }

func (b *Bundle) markdown(f File, r *http.Request, head bool, policyPath string) *Response {
	etag := f.ETag
	if etag == "" {
		sum := sha256.Sum256([]byte(f.Body))
		etag = `"` + hex.EncodeToString(sum[:])[:32] + `"`
	}
	tokens := 0
	if f.Tokens != nil {
		tokens = *f.Tokens
	} else if f.Body != "" {
		tokens = (len(f.Body) + 3) / 4
	}
	ctype := f.Type
	if ctype == "" {
		ctype = "text/markdown; charset=utf-8"
	}
	h := http.Header{}
	h.Set("Content-Type", ctype)
	h.Set("Vary", "Accept")
	h.Set("X-Markdown-Tokens", strconv.Itoa(tokens))
	h.Set("ETag", etag)
	h.Set("Cache-Control", b.cacheControl())
	for k, v := range b.PathHeadersFor(policyPath) {
		if v != "" {
			h.Set(k, v)
		}
	}
	if inm, ok := r.Header["If-None-Match"]; ok {
		want := stripWeak(etag)
		for _, t := range strings.Split(strings.Join(inm, ","), ",") {
			if t = stripWeak(t); t == "*" || t == want {
				return &Response{http.StatusNotModified, h, ""}
			}
		}
	}
	if head {
		return &Response{200, h, ""}
	}
	return &Response{200, h, f.Body}
}

// LinkHeaderValue is the Link header for an HTML page whose Markdown is published.
func LinkHeaderValue(pathname, origin string) string {
	abs := func(p string) string {
		if origin == "" {
			return p
		}
		return strings.TrimRight(origin, "/") + p
	}
	p := pathname
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	md := p + ".md"
	if p == "/" || p == "" {
		md = "/index.md"
	}
	return fmt.Sprintf(`<%s>; rel="alternate"; type="text/markdown", <%s>; rel="describedby"; type="text/markdown"`, abs(md), abs("/llms.txt"))
}

// DiscoveryHeaders are added to a human HTML page: Vary: Accept, Link (when the page's Markdown exists), policy headers.
func (b *Bundle) DiscoveryHeaders(pathname string) map[string]string {
	h := map[string]string{"vary": "Accept"}
	md := strings.TrimRight(pathname, "/") + ".md"
	if pathname == "/" {
		md = "/index.md"
	}
	if _, ok := b.file(md); ok {
		h["link"] = LinkHeaderValue(pathname, b.Origin)
	}
	for k, v := range b.PathHeadersFor(pathname) {
		if v != "" {
			h[strings.ToLower(k)] = v
		}
	}
	return h
}

// A Vary token equal to Accept (or *). Not `\baccept\b`, which also matches "Accept-Encoding".
var acceptWord = regexp.MustCompile(`(?i)(^|,)\s*(accept|\*)\s*(,|$)`)

// Decorate adds discovery headers to h when it describes an HTML response.
func (b *Bundle) Decorate(pathname string, h http.Header) {
	if !strings.Contains(h.Get("Content-Type"), "text/html") {
		return
	}
	for k, v := range b.DiscoveryHeaders(pathname) {
		switch k {
		case "vary":
			cur := strings.Join(h.Values("Vary"), ", ")
			if cur == "" {
				h.Set("Vary", "Accept")
			} else if !acceptWord.MatchString(cur) {
				h.Set("Vary", cur+", Accept")
			}
		case "link":
			h.Add("Link", v)
		default:
			h.Set(k, v)
		}
	}
}

// Middleware wraps next: bundle answers first, then the app with decorated HTML headers.
func (b *Bundle) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if res := b.Handle(r); res != nil {
			for k, vs := range res.Header {
				w.Header()[k] = vs
			}
			w.WriteHeader(res.Status)
			if res.Body != "" {
				_, _ = w.Write([]byte(res.Body))
			}
			return
		}
		path := r.URL.Path
		if path == "" {
			path = "/"
		}
		next.ServeHTTP(&decoratingWriter{ResponseWriter: w, b: b, path: path}, r)
	})
}

// decoratingWriter adds discovery headers just before the app's headers are sent.
type decoratingWriter struct {
	http.ResponseWriter
	b       *Bundle
	path    string
	written bool
}

func (d *decoratingWriter) WriteHeader(code int) {
	if !d.written {
		d.written = true
		d.b.Decorate(d.path, d.Header())
	}
	d.ResponseWriter.WriteHeader(code)
}

func (d *decoratingWriter) Write(p []byte) (int, error) {
	if !d.written {
		if d.Header().Get("Content-Type") == "" {
			d.Header().Set("Content-Type", http.DetectContentType(p))
		}
		d.WriteHeader(http.StatusOK)
	}
	return d.ResponseWriter.Write(p)
}

func (d *decoratingWriter) Flush() {
	if !d.written {
		d.WriteHeader(http.StatusOK)
	}
	if f, ok := d.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (d *decoratingWriter) Unwrap() http.ResponseWriter { return d.ResponseWriter }
