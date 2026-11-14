/**
 * @ispeakllm/lint — llms.txt validator + agent-readiness checker.
 * Pure: all network access goes through an injected `fetcher`.
 */

export type Severity = "error" | "warning";
export interface LintIssue { line: number; severity: Severity; code: string; message: string; }
export interface LintResult { ok: boolean; issues: LintIssue[]; }

const LINK_ITEM = /^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*:\s*(.*))?\s*$/;

/** Validate llms.txt against the llmstxt.org structure rules. */
export function lintLlmsTxt(input: string): LintResult {
  const issues: LintIssue[] = [];
  const add = (line: number, severity: Severity, code: string, message: string) => issues.push({ line, severity, code, message });
  const text = input.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) { add(1, "error", "empty", "File is empty; an H1 with the site name is required."); return { ok: false, issues }; }
  if (!/^# \S/.test(lines[i])) add(i + 1, "error", "h1-required", "The first non-empty line must be an H1 (`# Name`).");
  let h1Count = 0; let inFence = false; let seenH2 = false; let seenQuote = false; let section = "";
  let sawContentBeforeQuote = false;
  const seenSections = new Set<string>();
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]; const ln = n + 1;
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^# /.test(l)) { h1Count++; if (h1Count > 1) add(ln, "error", "multiple-h1", "Only one H1 is allowed."); continue; }
    if (/^## /.test(l)) {
      seenH2 = true; section = l.slice(3).trim();
      if (!section) add(ln, "error", "empty-heading", "H2 heading has no text.");
      if (seenSections.has(section.toLowerCase())) add(ln, "warning", "duplicate-section", `Duplicate section "${section}".`);
      seenSections.add(section.toLowerCase());
      continue;
    }
    if (/^#{3,6} /.test(l)) { add(ln, seenH2 ? "warning" : "error", seenH2 ? "deep-heading" : "heading-before-h2", seenH2 ? "Headings deeper than H2 are not part of the format." : "Only an H1 may precede the first H2; free-form text before it must not use headings."); continue; }
    if (/^> /.test(l)) { if (!seenQuote && !seenH2) seenQuote = true; continue; }
    if (!seenH2) { if (l.trim() && !seenQuote && n > i) sawContentBeforeQuote = true; continue; }
    if (l.trim() === "") continue;
    if (/^[-*]\s/.test(l)) {
      const m = LINK_ITEM.exec(l);
      if (!m) { add(ln, "error", "bad-link-item", "File-list entries must be `- [name](url)` optionally followed by `: notes`."); continue; }
      const url = m[2];
      if (!/^(https?:\/\/|\/|\.\/|\.\.\/)/.test(url)) add(ln, "warning", "odd-url", `URL "${url}" is neither absolute nor site-relative.`);
    } else add(ln, "warning", "text-in-file-list", "Free text inside a file-list section is ignored by parsers; put it before the first H2.");
  }
  if (!seenQuote) add(i + 1, "warning", "summary-missing", "A `> summary` blockquote after the H1 is recommended.");
  if (sawContentBeforeQuote && seenQuote) add(i + 1, "warning", "summary-order", "The summary blockquote should directly follow the H1.");
  if (!seenH2) add(lines.length, "warning", "no-sections", "No H2 file-list sections found.");
  if (seenSections.has("optional")) { /* ok */ }
  return { ok: !issues.some((x) => x.severity === "error"), issues };
}

// ---------------------------------------------------------------- readiness

export interface FetchResult { status: number; headers: Record<string, string>; body: string; }
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResult>;

export interface ReadinessItem { id: string; title: string; status: "pass" | "fail" | "warn" | "na"; detail: string; }
export interface ReadinessReport { url: string; items: ReadinessItem[]; passed: number; total: number; }

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Check a site for agent readiness. `origin` e.g. https://example.com. */
export async function checkReadiness(origin: string, fetcher: Fetcher): Promise<ReadinessReport> {
  const base = origin.replace(/\/+$/, "");
  const items: ReadinessItem[] = [];
  const safe = async (path: string, headers?: Record<string, string>) => { try { const r = await fetcher(base + path, headers ? { headers } : undefined); return { ...r, headers: lower(r.headers) }; } catch { return null; } };
  const push = (id: string, title: string, status: ReadinessItem["status"], detail: string) => items.push({ id, title, status, detail });

  const llms = await safe("/llms.txt");
  if (!llms || llms.status !== 200) push("llms-txt", "llms.txt present", "fail", `GET /llms.txt returned ${llms?.status ?? "no response"}.`);
  else {
    const l = lintLlmsTxt(llms.body);
    push("llms-txt", "llms.txt present and valid", l.ok ? "pass" : "fail", l.ok ? `Valid${l.issues.length ? ` (${l.issues.length} warnings)` : ""}.` : l.issues.filter((x) => x.severity === "error").map((x) => `line ${x.line}: ${x.message}`).join(" "));
  }
  const full = await safe("/llms-full.txt");
  push("llms-full", "llms-full.txt present", full?.status === 200 ? "pass" : "warn", full?.status === 200 ? "Present." : "Optional; not found.");

  const md = await safe("/", { accept: "text/markdown" });
  const mdOk = !!md && md.status === 200 && /text\/markdown/.test(md.headers["content-type"] ?? "");
  push("md-negotiation", "Accept: text/markdown negotiation", mdOk ? "pass" : "fail", mdOk ? "Returns text/markdown." : "Request with Accept: text/markdown did not return text/markdown.");
  if (mdOk) {
    push("vary-accept", "Vary: Accept on negotiated responses", /accept/i.test(md!.headers.vary ?? "") ? "pass" : "fail", md!.headers.vary ? `Vary: ${md!.headers.vary}` : "Missing Vary header; caches may serve Markdown to browsers.");
    push("md-validators", "ETag for conditional requests", md!.headers.etag ? "pass" : "warn", md!.headers.etag ? "ETag present." : "No ETag; agents cannot revalidate.");
    push("content-signal-header", "Content-Signal header", md!.headers["content-signal"] ? "pass" : "warn", md!.headers["content-signal"] ? md!.headers["content-signal"] : "No Content-Signal header on Markdown responses.");
  }
  const html = await safe("/", { accept: "text/html" });
  push("html-unchanged", "Browsers still get HTML", html && /text\/html/.test(html.headers["content-type"] ?? "") ? "pass" : "fail", html ? `Content-Type: ${html.headers["content-type"] ?? "n/a"}` : "No response.");

  const robots = await safe("/robots.txt");
  const rb = robots?.status === 200 ? robots.body : "";
  push("content-signals", "Content Signals / AI-use signals in robots.txt", /content-signal\s*:|content-usage\s*:|__usage_ai-training/i.test(rb) ? "pass" : "warn", /content-signal\s*:|content-usage\s*:|__usage_ai-training/i.test(rb) ? "AI-use signal found." : "No Content-Signal, Content-Usage or __usage_ai-training rule in robots.txt.");

  const wba = await safe("/.well-known/http-message-signatures-directory");
  push("web-bot-auth", "Web Bot Auth key directory (for sites that send signed requests)", wba?.status === 200 ? "pass" : "na", wba?.status === 200 ? "Directory present." : "Not applicable unless this site operates a bot.");
  const card = await safe("/.well-known/mcp/server-card.json");
  push("mcp-card", "MCP Server Card", card?.status === 200 ? "pass" : "warn", card?.status === 200 ? "Present." : "No /.well-known/mcp/server-card.json.");
  const cat = await safe("/.well-known/api-catalog");
  push("api-catalog", "API Catalog (RFC 9727)", cat?.status === 200 ? "pass" : "na", cat?.status === 200 ? "Present." : "Only relevant for sites with public APIs.");

  const scored = items.filter((x) => x.status !== "na");
  return { url: base, items, passed: scored.filter((x) => x.status === "pass").length, total: scored.length };
}
