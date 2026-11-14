/**
 * HTTP helpers: Link headers, markdown response headers, ETag and conditional
 * requests. Pure functions over plain strings/records; no Response objects, so
 * they work in any runtime.
 */

import { sha256Hex, estimateTokens } from "./hash";
import { mdPathFor } from "./generate";

export type HeaderBag = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function readHeader(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as { get?: unknown }).get === "function") return (h as { get(n: string): string | null }).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

export type LinkHeaderOptions = {
  /** Path of the HTML page being served (e.g. `/about`). */
  pathname: string;
  /** Site origin for absolute URLs; omit for relative. */
  origin?: string;
  /** Override the Markdown path (needed for a locale home such as `/de/index.md`). */
  mdPath?: string;
  /** Path of the llms.txt describing this site (default `/llms.txt`; `/de/llms.txt` for a locale). Set `false` to omit. */
  llmsTxtPath?: string | false;
  /** Other-language versions of this page: `{ locale: "de", href: "/de/about" }`. */
  alternates?: { locale: string; href: string; type?: string }[];
};

/**
 * Link values for an HTML page response so agents can discover the Markdown:
 *   `</about.md>; rel="alternate"; type="text/markdown"`
 *   `</llms.txt>; rel="describedby"; type="text/markdown"`
 * Returns one value per link; join with `, ` (see `linkHeaderValue`).
 */
export function linkHeaders(opts: LinkHeaderOptions): string[] {
  const abs = (p: string) => (opts.origin ? opts.origin.replace(/\/+$/, "") + p : p);
  const out = [`<${abs(opts.mdPath ?? mdPathFor(opts.pathname))}>; rel="alternate"; type="text/markdown"`];
  if (opts.llmsTxtPath !== false) out.push(`<${abs(opts.llmsTxtPath ?? "/llms.txt")}>; rel="describedby"; type="text/markdown"`);
  for (const a of opts.alternates ?? []) {
    const href = /^https?:\/\//.test(a.href) ? a.href : abs(a.href);
    out.push(`<${href}>; rel="alternate"; hreflang="${a.locale}"${a.type ? `; type="${a.type}"` : ""}`);
  }
  return out;
}

export function linkHeaderValue(opts: LinkHeaderOptions): string {
  return linkHeaders(opts).join(", ");
}

/** Strong ETag from the SHA-256 of the body: `"<32 hex chars>"`. */
export async function etag(body: string | Uint8Array): Promise<string> {
  return `"${(await sha256Hex(body)).slice(0, 32)}"`;
}

export type MarkdownHeaderOptions = {
  /** Precomputed ETag (e.g. from a page hash); computed from the body when absent. */
  etag?: string;
  lastModified?: string;
  contentType?: string;
  cacheControl?: string;
};

/**
 * Response headers for a Markdown variant: `Content-Type: text/markdown; charset=utf-8`,
 * `Vary: Accept`, `x-markdown-tokens` (estimateTokens) and `ETag`.
 */
export async function markdownHeaders(body: string, opts: MarkdownHeaderOptions = {}): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    "Content-Type": opts.contentType ?? "text/markdown; charset=utf-8",
    Vary: "Accept",
    "x-markdown-tokens": String(estimateTokens(body)),
    ETag: opts.etag ?? (await etag(body)),
  };
  if (opts.lastModified) h["Last-Modified"] = new Date(opts.lastModified).toUTCString();
  if (opts.cacheControl) h["Cache-Control"] = opts.cacheControl;
  return h;
}

const stripWeak = (t: string): string => t.trim().replace(/^W\//, "");

export type ConditionalResult = { status: 304; headers: Record<string, string> };

/**
 * Conditional request check (RFC 9110 section 13). Returns a 304 descriptor when
 * `If-None-Match` matches `etag` (weak comparison, `*` supported), or, when no
 * `If-None-Match` is sent, when `If-Modified-Since` is not older than `lastModified`.
 * Returns `null` when the full response should be sent. 304 headers carry ETag
 * (and Vary/Last-Modified) as required.
 */
export function handleConditional(request: HeaderBag, etagValue: string, lastModified?: string): ConditionalResult | null {
  const base: Record<string, string> = { ETag: etagValue, Vary: "Accept" };
  if (lastModified) base["Last-Modified"] = new Date(lastModified).toUTCString();
  const inm = readHeader(request, "if-none-match");
  if (inm !== undefined) {
    const tags = inm.split(",").map(stripWeak);
    if (tags.includes("*") || tags.includes(stripWeak(etagValue))) return { status: 304, headers: base };
    return null;
  }
  const ims = readHeader(request, "if-modified-since");
  if (ims && lastModified) {
    const since = Date.parse(ims);
    const modified = Date.parse(lastModified);
    if (!Number.isNaN(since) && !Number.isNaN(modified) && Math.floor(modified / 1000) <= Math.floor(since / 1000)) {
      return { status: 304, headers: base };
    }
  }
  return null;
}
