// Ported from llms-txt/src/generate.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * Deterministic renderings following llmstxt.org (v2 conventions):
 *
 *   llms.txt        `# Title`, `> summary`, optional free text, then `## Section`
 *                   H2 lists of `- [name](url): notes`. The reserved `Optional`
 *                   section (always last) holds pages that can be skipped for a
 *                   shorter context. Links point at the `page.md` form.
 *   llms-full.txt   every page's Markdown, in index order, separated by `---`.
 *   pages[]         `{ path, md, hash, ... }`: per-page Markdown + SHA-256.
 *
 * Determinism: identical input gives identical bytes, regardless of the
 * order `list()` returns pages. Pages sort by (-priority, section, path);
 * line endings are normalised to LF.
 */

import type { AcmSection, ContentSource, PageContent, PageRef } from "./types";
import { sha256Hex, estimateTokens } from "./hash";

export type ViewFilter = {
  /** Keep pages tagged for this audience, plus pages with no audience. */
  audience?: string;
  /** Keep only pages whose `section` is one of these ids. */
  sections?: string[];
};

export type LocaleAlternate = {
  locale: string;
  /** Human label (defaults to the locale code; no Intl lookups, to stay deterministic across runtimes). */
  name?: string;
  /** Path of that locale's llms.txt, e.g. `/de/llms.txt`. */
  llmsTxtPath: string;
};

export type GenerateOptions = {
  /** Site title: the `# H1` of `llms.txt` / `llms-full.txt`. */
  title: string;
  /** One-line site summary: the `> blockquote` under the H1. */
  summary?: string;
  /** Optional free-text paragraph(s) between the summary and the first H2 (no headings). */
  details?: string;
  /** Site origin (no trailing slash) for absolute links. Defaults to relative links. */
  origin?: string;
  /** Sections (id -> title + priority). Pages reference them by `section`. */
  sections?: AcmSection[];
  /** Prefix for every output path, e.g. `/de` (used by generateLocales). */
  basePath?: string;
  /** Audience / section filter (a "view" of the site). */
  view?: ViewFilter;
  /** Other languages, rendered as a `Languages` section before `Optional`. */
  alternates?: LocaleAlternate[];
};

export type GeneratedPage = {
  /** Output site path (includes `basePath`). */
  path: string;
  /** Path of the Markdown rendering, e.g. `/about.md` (`/` -> `/index.md`). */
  mdPath: string;
  /** Per-page Markdown (header + body), as served at `mdPath`. */
  md: string;
  /** SHA-256 hex of `md`. */
  hash: string;
  /** The page reference with the output path. */
  ref: PageRef;
};

export type GeneratedGroup = {
  title: string;
  optional: boolean;
  pages: GeneratedPage[];
};

export type GeneratedOutputs = {
  title: string;
  summary?: string;
  basePath: string;
  pages: GeneratedPage[];
  groups: GeneratedGroup[];
  llmsTxt: string;
  llmsFullTxt: string;
};

/** Sort by (-priority, section, path). */
export function sortPages<T extends { priority?: number; section?: string; path: string }>(refs: T[]): T[] {
  return [...refs].sort((a, b) => {
    const ap = a.priority ?? 0;
    const bp = b.priority ?? 0;
    if (bp !== ap) return bp - ap;
    const as = a.section ?? "";
    const bs = b.section ?? "";
    if (as !== bs) return as < bs ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

const lf = (s: string): string => s.replace(/\r\n?/g, "\n");
const oneLine = (s: string): string => lf(s).replace(/\s+/g, " ").trim();

/** `/about` -> `/about.md`; `/` -> `/index.md` (the llmstxt.org `page.md` form). */
export function mdPathFor(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return p === "/" || p === "" ? "/index.md" : p + ".md";
}

/** Render one page as the Markdown served at its `.md` URL: `# title`, optional `> summary`, blank line, body. */
const norm = (t: string): string => oneLine(t).toLowerCase();

export function renderPageMarkdown(content: PageContent): string {
  const head = [`# ${oneLine(content.ref.title)}`];
  if (content.ref.summary) head.push(`> ${oneLine(content.ref.summary)}`);
  let body = lf(content.body).replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  // Most sources open with the same H1 the header already carries: drop it so the title appears once.
  const h1 = /^#[ \t]+(.+?)[ \t#]*(?:\n|$)/.exec(body);
  if (h1 && norm(h1[1]!) === norm(content.ref.title)) body = body.slice(h1[0].length).replace(/^(?:[ \t]*\n)+/, "");
  return head.join("\n") + "\n\n" + body + (body ? "\n" : "");
}

function encodeHref(href: string): string {
  return encodeURI(href).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function absolute(origin: string | undefined, path: string): string {
  const rel = encodeHref(path);
  return origin ? origin.replace(/\/+$/, "") + rel : rel;
}

const escapeLinkText = (s: string): string => oneLine(s).replace(/([\[\]])/g, "\\$1");

/** Apply a view filter to page refs. */
export function filterView<T extends PageRef>(refs: T[], view?: ViewFilter): T[] {
  if (!view) return refs;
  return refs.filter((r) => {
    if (view.audience && r.audience && r.audience.length > 0 && !r.audience.includes(view.audience)) return false;
    if (view.sections && !(r.section && view.sections.includes(r.section))) return false;
    return true;
  });
}

type RefGroup = { title: string; optional: boolean; refs: PageRef[] };

/** Group refs: declared sections (by priority), then seen sections (alphabetical), then `Pages`, then `Optional`. Empty groups are omitted. */
function groupRefs(refs: PageRef[], opts: Pick<GenerateOptions, "sections">): RefGroup[] {
  const sorted = sortPages(refs);
  const main = sorted.filter((r) => !r.optional);
  const optional = sorted.filter((r) => r.optional);
  const declared = [...(opts.sections ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const declaredIds = new Set(declared.map((s) => s.id));
  const seenIds = [...new Set(main.map((r) => r.section).filter((s): s is string => !!s && !declaredIds.has(s)))].sort();
  const groups: RefGroup[] = [
    ...declared.map((s) => ({ title: oneLine(s.title), optional: false, refs: main.filter((r) => r.section === s.id) })),
    ...seenIds.map((id) => ({ title: oneLine(id), optional: false, refs: main.filter((r) => r.section === id) })),
    { title: "Pages", optional: false, refs: main.filter((r) => !r.section) },
    { title: "Optional", optional: true, refs: optional },
  ];
  return groups.filter((g) => g.refs.length > 0);
}

function row(ref: PageRef, origin: string | undefined): string {
  const tail = ref.summary ? `: ${oneLine(ref.summary)}` : "";
  return `- [${escapeLinkText(ref.title)}](${absolute(origin, mdPathFor(ref.path))})${tail}`;
}

function renderIndex(groups: RefGroup[], opts: GenerateOptions): string {
  const lines: string[] = [`# ${oneLine(opts.title)}`];
  if (opts.summary) lines.push("", `> ${oneLine(opts.summary)}`);
  if (opts.details) lines.push("", lf(opts.details).replace(/\s+$/, ""));
  const emit = (g: RefGroup) => {
    lines.push("", `## ${g.title}`, "");
    for (const r of g.refs) lines.push(row(r, opts.origin));
  };
  for (const g of groups.filter((x) => !x.optional)) emit(g);
  if (opts.alternates && opts.alternates.length > 0) {
    lines.push("", "## Languages", "");
    for (const a of [...opts.alternates].sort((x, y) => (x.locale < y.locale ? -1 : 1))) {
      lines.push(`- [${escapeLinkText(a.name ?? a.locale)}](${absolute(opts.origin, a.llmsTxtPath)}): alternate (${a.locale}) llms.txt`);
    }
  }
  for (const g of groups.filter((x) => x.optional)) emit(g);
  return lines.join("\n") + "\n";
}

/** Render the curated `llms.txt` from page refs. */
export function renderLlmsTxt(refs: PageRef[], opts: GenerateOptions): string {
  return renderIndex(groupRefs(refs, opts), opts);
}

/** Render `llms-full.txt`: H1, optional summary, then every page's Markdown in index order, joined by `---`. */
export function renderLlmsFullTxt(groups: GeneratedGroup[], opts: Pick<GenerateOptions, "title" | "summary">): string {
  const lines: string[] = [`# ${oneLine(opts.title)}`];
  if (opts.summary) lines.push("", `> ${oneLine(opts.summary)}`);
  const pages = groups.flatMap((g) => g.pages);
  return lines.join("\n") + "\n\n" + pages.map((p) => p.md.replace(/\n$/, "")).join("\n\n---\n\n") + "\n";
}

/** Walk the `ContentSource` and render llms.txt, llms-full.txt and per-page Markdown deterministically. */
export async function generate(source: ContentSource, opts: GenerateOptions): Promise<GeneratedOutputs> {
  const basePath = (opts.basePath ?? "").replace(/\/+$/, "");
  const listed = await source.list();
  const seen = new Set<string>();
  for (const r of listed) {
    if (seen.has(r.path)) throw new Error(`@ispeakllm/core: duplicate path ${r.path}`);
    seen.add(r.path);
  }
  const refs = sortPages(filterView(listed, opts.view));
  const byOutPath = new Map<string, GeneratedPage>();
  const outRefs: PageRef[] = [];
  for (const ref of refs) {
    const content = await source.load(ref);
    const md = renderPageMarkdown(content);
    const outPath = basePath + (ref.path === "/" ? "" : ref.path) || "/";
    const outRef: PageRef = { ...ref, path: outPath };
    outRefs.push(outRef);
    byOutPath.set(outPath, { path: outPath, mdPath: ref.path === "/" ? `${basePath}/index.md` : mdPathFor(outPath), md, hash: await sha256Hex(md), ref: outRef });
  }
  const groups: GeneratedGroup[] = groupRefs(outRefs, opts).map((g) => ({
    title: g.title,
    optional: g.optional,
    pages: g.refs.map((r) => byOutPath.get(r.path)!),
  }));
  const out: GeneratedOutputs = {
    title: oneLine(opts.title),
    basePath,
    pages: groups.flatMap((g) => g.pages),
    groups,
    llmsTxt: renderIndex(groupRefs(outRefs, opts), opts),
    llmsFullTxt: renderLlmsFullTxt(groups, opts),
  };
  if (opts.summary) out.summary = oneLine(opts.summary);
  return out;
}

/* ---------------------------------------------------------------- files */

export type OutputFile = { path: string; content: string; contentType: string };
const MD_TYPE = "text/markdown; charset=utf-8";

/** Flatten outputs into servable files: `/llms.txt`, `/llms-full.txt`, every page `.md`. */
export function toFiles(out: GeneratedOutputs): OutputFile[] {
  return [
    { path: `${out.basePath}/llms.txt`, content: out.llmsTxt, contentType: MD_TYPE },
    { path: `${out.basePath}/llms-full.txt`, content: out.llmsFullTxt, contentType: MD_TYPE },
    ...out.pages.map((p) => ({ path: p.mdPath, content: p.md, contentType: MD_TYPE })),
  ];
}

/* --------------------------------------------------------------- locales */

export type GenerateLocalesOptions = Omit<GenerateOptions, "basePath" | "alternates" | "view"> & {
  /** Locale served unprefixed (`/llms.txt`). Others live under `/<locale>/`. */
  defaultLocale: string;
  /** Per-locale overrides (title, summary, sections...). */
  localeOptions?: Record<string, Partial<Omit<GenerateOptions, "basePath" | "alternates">>>;
  /** Display names for the Languages section (default: the locale code). */
  localeNames?: Record<string, string>;
};

export type GeneratedLocales = {
  defaultLocale: string;
  locales: Record<string, GeneratedOutputs & { locale: string; alternates: LocaleAlternate[] }>;
  /** Every file for every locale, sorted by path. */
  files: OutputFile[];
};

/** Per-locale generation. Each locale has its own llms.txt / llms-full.txt / pages and lists the others as alternates. */
export async function generateLocales(sources: Record<string, ContentSource>, opts: GenerateLocalesOptions): Promise<GeneratedLocales> {
  const codes = Object.keys(sources).sort();
  if (!(opts.defaultLocale in sources)) throw new Error(`@ispeakllm/core: defaultLocale ${opts.defaultLocale} has no source.`);
  const prefixOf = (l: string) => (l === opts.defaultLocale ? "" : `/${l}`);
  const locales: GeneratedLocales["locales"] = {};
  const files: OutputFile[] = [];
  const { defaultLocale: _d, localeOptions, localeNames, ...base } = opts;
  for (const locale of codes) {
    const alternates: LocaleAlternate[] = codes
      .filter((l) => l !== locale)
      .map((l) => ({ locale: l, name: localeNames?.[l], llmsTxtPath: `${prefixOf(l)}/llms.txt` }))
      .map((a) => (a.name === undefined ? { locale: a.locale, llmsTxtPath: a.llmsTxtPath } : a));
    const out = await generate(sources[locale]!, { ...base, ...localeOptions?.[locale], basePath: prefixOf(locale), alternates });
    locales[locale] = { ...out, locale, alternates };
    files.push(...toFiles(out));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { defaultLocale: opts.defaultLocale, locales, files };
}

/* ----------------------------------------------------------------- views */

export type ViewSpec = ViewFilter & { title?: string; summary?: string };

/**
 * Audience views: filtered llms.txt / llms-full.txt per named view, served at
 * `/views/<name>/llms.txt` and `/views/<name>/llms-full.txt`. Links point at
 * the canonical per-page `.md` files (pages are not duplicated).
 */
export async function generateViews(
  source: ContentSource,
  opts: GenerateOptions,
  views: Record<string, ViewSpec>,
): Promise<{ views: Record<string, GeneratedOutputs>; files: OutputFile[] }> {
  const result: Record<string, GeneratedOutputs> = {};
  const files: OutputFile[] = [];
  for (const name of Object.keys(views).sort()) {
    const { title, summary, ...view } = views[name]!;
    const out = await generate(source, { ...opts, title: title ?? opts.title, summary: summary ?? opts.summary, view });
    result[name] = out;
    files.push(
      { path: `/views/${name}/llms.txt`, content: out.llmsTxt, contentType: MD_TYPE },
      { path: `/views/${name}/llms-full.txt`, content: out.llmsFullTxt, contentType: MD_TYPE },
    );
  }
  return { views: result, files };
}

/* ----------------------------------------------------------------- ctx */

export type CtxOptions = {
  /** Include the `Optional` section (llms-ctx-full). Default false (llms-ctx). */
  includeOptional?: boolean;
  /** Maximum estimated tokens (see estimateTokens). Whole documents only; documents that do not fit are skipped. */
  budgetTokens?: number;
};

export type CtxResult = { text: string; tokens: number; included: string[]; omitted: string[]; truncated: boolean };

const xmlAttr = (s: string): string => oneLine(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * llms-ctx export (modelled on llmstxt.org's `llms_txt2ctx`): the index
 * expanded into one XML-ish context document with each page's Markdown inlined:
 * `<project title summary><section name><doc title url desc>...</doc></section><optional>...</optional></project>`.
 * With `budgetTokens`, documents are added in index order while they fit.
 */
export function exportCtx(out: GeneratedOutputs, opts: CtxOptions = {}, origin?: string): CtxResult {
  const budget = opts.budgetTokens;
  const open = `<project title="${xmlAttr(out.title)}"${out.summary ? ` summary="${xmlAttr(out.summary)}"` : ""}>\n`;
  const close = "</project>\n";
  const bytes = (t: string): number => new TextEncoder().encode(t).length;
  const limit = budget === undefined ? Infinity : budget * 4; // estimateTokens = ceil(bytes / 4), so bytes <= 4 * budget
  let used = bytes(open + close);
  const included: string[] = [];
  const omitted: string[] = [];
  const parts: string[] = [];
  for (const g of out.groups) {
    if (g.optional && !opts.includeOptional) {
      omitted.push(...g.pages.map((p) => p.path));
      continue;
    }
    const tag = g.optional ? "optional" : "section";
    const head = g.optional ? `<optional>\n` : `<section name="${xmlAttr(g.title)}">\n`;
    const tail = `</${tag}>\n`;
    const docs: string[] = [];
    const groupCost = bytes(head + tail);
    for (const p of g.pages) {
      const doc =
        `<doc title="${xmlAttr(p.ref.title)}" url="${xmlAttr(absolute(origin, p.mdPath))}"${p.ref.summary ? ` desc="${xmlAttr(p.ref.summary)}"` : ""}>\n` +
        p.md +
        `</doc>\n`;
      const cost = bytes(doc);
      const extra = docs.length === 0 ? groupCost + cost : cost;
      if (used + extra > limit) {
        omitted.push(p.path);
        continue;
      }
      if (docs.length === 0) used += groupCost;
      used += cost;
      docs.push(doc);
      included.push(p.path);
    }
    if (docs.length > 0) parts.push(head + docs.join("") + tail);
  }
  const text = open + parts.join("") + close;
  return { text, tokens: estimateTokens(text), included, omitted, truncated: omitted.length > 0 };
}
