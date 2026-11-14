// Ported from packages/core/src/negotiate.ts (ispeakllm; itself from llms-txt/src/negotiate.ts, goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT

package ispeakllm

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ACMPath and ACMType identify the AI Conformance Manifest.
const (
	ACMPath = "/.well-known/ai-conformance.json"
	ACMType = "application/ai-conformance+json"
)

var qParam = regexp.MustCompile(`(?i)^\s*q\s*=\s*([0-9.]+)\s*$`)

// AcceptEntry is one media range of an Accept header.
type AcceptEntry struct {
	Type  string
	Q     float64
	Index int
}

// ParseAccept parses an Accept header (q clamped to 0..1, unparseable q = 0).
func ParseAccept(header string) []AcceptEntry {
	if header == "" {
		return nil
	}
	var out []AcceptEntry
	for index, part := range strings.Split(header, ",") {
		pieces := strings.Split(part, ";")
		typ := strings.ToLower(strings.TrimSpace(pieces[0]))
		if typ == "" {
			continue
		}
		q := 1.0
		for _, p := range pieces[1:] {
			if m := qParam.FindStringSubmatch(p); m != nil {
				if n, err := strconv.ParseFloat(m[1], 64); err == nil {
					q = min(1, max(0, n))
				} else {
					q = 0
				}
			}
		}
		out = append(out, AcceptEntry{typ, q, index})
	}
	return out
}

// Negotiate returns the variant ("md", "llmstxt", "llmsfull", "acm" or "html") and, for "md", the page path.
// Explicit paths win; then Accept decides by q, text/markdown and the ACM type must be named explicitly,
// equal q prefers the ACM type, then whichever of markdown/HTML is listed first; q=0 excludes.
func Negotiate(path, accept string) (string, string) {
	switch path {
	case ACMPath:
		return "acm", ""
	case "/llms.txt":
		return "llmstxt", ""
	case "/llms-full.txt":
		return "llmsfull", ""
	}
	if strings.HasSuffix(path, ".md") {
		page := strings.TrimSuffix(path, ".md")
		if page == "" || page == "/index" {
			page = "/"
		} else if strings.HasSuffix(page, "/index") {
			page = strings.TrimSuffix(page, "/index")
			if page == "" {
				page = "/"
			}
		}
		return "md", page
	}

	entries := ParseAccept(accept)
	find := func(t string) *AcceptEntry {
		for i := range entries {
			if entries[i].Type == t {
				return &entries[i]
			}
		}
		return nil
	}
	acm, md := find(ACMType), find("text/markdown")
	html := find("text/html")
	if html == nil {
		html = find("text/*")
	}
	if html == nil {
		html = find("*/*")
	}
	type cand struct {
		variant     string
		q           float64
		rank, index int
	}
	var cands []cand
	if acm != nil && acm.Q > 0 {
		cands = append(cands, cand{"acm", acm.Q, 0, acm.Index})
	}
	if md != nil && md.Q > 0 {
		cands = append(cands, cand{"md", md.Q, 1, md.Index})
	}
	if html != nil && html.Q > 0 {
		cands = append(cands, cand{"html", html.Q, 1, html.Index})
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.q != b.q {
			return a.q > b.q
		}
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		return a.index < b.index
	})
	if len(cands) > 0 {
		switch cands[0].variant {
		case "acm":
			return "acm", ""
		case "md":
			page := path
			if strings.HasSuffix(page, "/") && page != "/" {
				page = page[:len(page)-1]
			}
			return "md", page
		}
	}
	return "html", ""
}
