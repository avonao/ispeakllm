// Ported from integrations/go-middleware/llmstxt_test.go (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT

package ispeakllm

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const conf = "../../conformance/adapter-http"

// hostApp is the reference host from cases.json `host`.
var hostApp = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if strings.HasPrefix(r.URL.Path, "/no-such-page") {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("<html>missing</html>"))
		return
	}
	_, _ = w.Write([]byte("<html>host</html>"))
})

func TestConformanceCoreOverHTTP(t *testing.T) {
	b, err := Load(filepath.Join(conf, "bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(b.Middleware(hostApp)) // 127.0.0.1, random port
	defer srv.Close()

	out, err := exec.Command("node", filepath.Join(conf, "runner.mjs"), srv.URL, "--level", "core").CombinedOutput()
	t.Log("\n" + string(out))
	if err != nil {
		t.Fatalf("conformance runner failed: %v", err)
	}
}

func TestNegotiateTies(t *testing.T) {
	cases := []struct{ path, accept, variant, page string }{
		{"/x", "text/markdown, text/html", "md", "/x"},
		{"/x", "text/html, text/markdown", "html", ""},
		{"/x", "*/*", "html", ""},
		{"/x", "text/markdown;q=0", "html", ""},
		{"/docs/index.md", "", "md", "/docs"},
		{"/x/", "application/ai-conformance+json, text/markdown", "acm", ""},
	}
	for _, c := range cases {
		v, p := Negotiate(c.path, c.accept)
		if v != c.variant || p != c.page {
			t.Errorf("Negotiate(%q, %q) = %q, %q; want %q, %q", c.path, c.accept, v, p, c.variant, c.page)
		}
	}
}

func TestPassThroughKeepsVaryAndBody(t *testing.T) {
	b, err := Load(filepath.Join(conf, "bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	app := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Vary", "Accept-Encoding")
		_, _ = w.Write([]byte("<!doctype html><p>hi</p>")) // no Content-Type: sniffed
	})
	rr := httptest.NewRecorder()
	b.Middleware(app).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/pricing", nil))
	if got := rr.Header().Get("Vary"); got != "Accept-Encoding, Accept" {
		t.Errorf("vary = %q", got)
	}
	if got := rr.Header().Get("Link"); !strings.Contains(got, "/pricing.md>") {
		t.Errorf("link = %q", got)
	}
	if rr.Body.String() != "<!doctype html><p>hi</p>" {
		t.Errorf("body changed: %q", rr.Body.String())
	}
}
