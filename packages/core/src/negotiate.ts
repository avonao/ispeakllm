// Ported from llms-txt/src/negotiate.ts (goplainly-v6-2026-11-10-current-dormant); Accept/.md rules also from middleware.ts (entpoind-f1-2026-11-10-site-agent-surface-reference)
/**
 * Content negotiation: a pure function over `(pathname, Accept)` returning
 * which variant to serve. Framework-agnostic: the adapter shapes the Response.
 *
 * Rules:
 *   1. Explicit paths win: `/llms.txt`, `/llms-full.txt`, `/.well-known/ai-conformance.json`,
 *      and any `<path>.md` (`/index.md` is the home page). With `locales`, a leading
 *      `/<locale>` is recognised (`/de/llms.txt`) and reported.
 *   2. Otherwise the `Accept` header decides, with q-values. `text/markdown` and
 *      `application/ai-conformance+json` must be named explicitly; wildcards never
 *      select them. HTML is accepted via `text/html`, `text/*` or `*` slash `*`.
 *      The highest q wins. On equal q, the ACM type wins, and between markdown and
 *      HTML the one listed first wins. So a browser (`text/html,...`) gets HTML, an
 *      agent sending `text/markdown` gets Markdown, and `text/markdown, text/html;q=0.5`
 *      gets Markdown.
 *   3. No header, or nothing matched: `html` (the caller serves the normal page).
 */

export type NegotiationVariant = "md" | "llmstxt" | "llmsfull" | "acm" | "html";

export type NegotiationInput = {
  pathname: string;
  accept?: string | null;
  /** Known locale prefixes (e.g. `["de", "fr"]`) for `/de/llms.txt` style paths. */
  locales?: string[];
};

export type NegotiationVerdict = {
  variant: NegotiationVariant;
  /** For `md`: the site-relative page path (`.md` stripped, trailing slash removed). */
  pagePath?: string;
  /** Locale prefix the path carried, if any. */
  locale?: string;
};

const ACM_PATH = "/.well-known/ai-conformance.json";
const ACM_TYPE = "application/ai-conformance+json";

type AcceptEntry = { type: string; q: number; index: number };

export function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header) return [];
  const out: AcceptEntry[] = [];
  header.split(",").forEach((part, index) => {
    const [typeRaw, ...params] = part.split(";");
    const type = (typeRaw ?? "").trim().toLowerCase();
    if (!type) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) {
        const n = Number(m[1]);
        q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
      }
    }
    out.push({ type, q, index });
  });
  return out;
}

function explicit(entries: AcceptEntry[], type: string): AcceptEntry | undefined {
  return entries.find((e) => e.type === type);
}

function htmlMatch(entries: AcceptEntry[]): AcceptEntry | undefined {
  return explicit(entries, "text/html") ?? explicit(entries, "text/*") ?? explicit(entries, "*/*");
}

function splitLocale(path: string, locales: string[] | undefined): { rest: string; locale?: string } {
  if (locales) {
    for (const l of locales) {
      if (path === `/${l}`) return { rest: "/", locale: l };
      if (path.startsWith(`/${l}/`)) return { rest: path.slice(l.length + 1), locale: l };
    }
  }
  return { rest: path };
}

export function negotiate(input: NegotiationInput): NegotiationVerdict {
  const path = input.pathname;
  const { rest, locale } = splitLocale(path, input.locales);
  const withLocale = <T extends NegotiationVerdict>(v: T): T => (locale ? { ...v, locale } : v);

  // 1. Explicit-path routing.
  if (path === ACM_PATH) return { variant: "acm" };
  if (rest === "/llms.txt") return withLocale({ variant: "llmstxt" });
  if (rest === "/llms-full.txt") return withLocale({ variant: "llmsfull" });
  if (path.endsWith(".md")) {
    let pagePath = path.slice(0, -3);
    if (pagePath === "" || pagePath === "/index") pagePath = "/";
    else if (pagePath.endsWith("/index")) pagePath = pagePath.slice(0, -6) || "/";
    return withLocale({ variant: "md", pagePath });
  }

  // 2. Accept negotiation.
  const entries = parseAccept(input.accept);
  const acm = explicit(entries, ACM_TYPE);
  const md = explicit(entries, "text/markdown");
  const html = htmlMatch(entries);
  type Cand = { variant: NegotiationVariant; q: number; rank: number; index: number };
  const cands: Cand[] = [];
  if (acm && acm.q > 0) cands.push({ variant: "acm", q: acm.q, rank: 0, index: acm.index });
  if (md && md.q > 0) cands.push({ variant: "md", q: md.q, rank: 1, index: md.index });
  if (html && html.q > 0) cands.push({ variant: "html", q: html.q, rank: 1, index: html.index });
  cands.sort((a, b) => b.q - a.q || a.rank - b.rank || a.index - b.index);
  const best = cands[0];
  if (best?.variant === "acm") return { variant: "acm" };
  if (best?.variant === "md") {
    const pagePath = rest.endsWith("/") && rest !== "/" ? rest.slice(0, -1) : rest;
    return withLocale({ variant: "md", pagePath: locale ? path.replace(/\/+$/, "") || "/" : pagePath });
  }
  return { variant: "html" };
}
