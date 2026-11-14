// Ported from llms-txt/src/mdx-adapter.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * ContentSource adapters. All are runtime-neutral (no node:fs): callers hand
 * in `{ path, raw }` records (the CLI builds them from disk; a Worker from KV
 * or R2; JsonEndpointAdapter from a JSON document).
 *
 *   FilesAdapter        plain Markdown files + optional frontmatter (lenient title)
 *   MdxAdapter          .md/.mdx with required frontmatter title (strict), MDX import/export lines dropped
 *   JsonEndpointAdapter pure parse of `{ files: [{ path, raw, lastModified? }] }`
 *   StaticSource        pages supplied programmatically (catalogue mode)
 */

import type { ContentSource, PageContent, PageRef } from "./types";
import { parseFrontmatter, type YamlParser } from "./frontmatter";

export type SourceFile = {
  /** Site-relative path starting with `/`, e.g. `/about`. See `pathFromFile`. */
  path: string;
  /** Raw file contents including any frontmatter block. */
  raw: string;
  /** Optional ISO-8601 mtime. */
  lastModified?: string;
};
/** Alias kept for the ported API. */
export type MdxFile = SourceFile;

export type AdapterOptions = {
  /** Override the built-in YAML-lite frontmatter parser. */
  parser?: YamlParser;
};
export type MdxAdapterOptions = AdapterOptions;

/** `posts/hello.md` -> `/posts/hello`; `index.md` -> `/`; `a/index.mdx` -> `/a`. */
export function pathFromFile(filePath: string, root = ""): string {
  let p = filePath.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r && p.startsWith(r + "/")) p = p.slice(r.length + 1);
  p = p.replace(/^\.?\/+/, "").replace(/\.(md|mdx|markdown)$/i, "");
  if (p === "index") return "/";
  if (p.endsWith("/index")) p = p.slice(0, -6);
  return "/" + p;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toAudience(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const a = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return a.length ? a : undefined;
  }
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function refFromFrontmatter(path: string, title: string, fm: Record<string, unknown>, lastModified: string | undefined): PageRef {
  const ref: PageRef = { path, title };
  const summary = str(fm.summary);
  if (summary !== undefined) ref.summary = summary;
  const section = str(fm.section);
  if (section !== undefined) ref.section = section;
  if (typeof fm.priority === "number") ref.priority = fm.priority;
  const lm = str(fm.lastModified) ?? lastModified;
  if (lm !== undefined) ref.lastModified = lm;
  if (fm.optional === true) ref.optional = true;
  const audience = toAudience(fm.audience);
  if (audience) ref.audience = audience;
  return ref;
}

function assertPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`@ispeakllm/core: file path must start with '/': got ${JSON.stringify(path)}`);
  }
}

type Entry = { ref: PageRef; body: string; frontmatter: Record<string, unknown> };

abstract class FrontmatterSource implements ContentSource {
  protected readonly byPath = new Map<string, Entry>();

  protected abstract titleFor(path: string, fm: Record<string, unknown>, body: string): string;
  protected prepareBody(body: string): string {
    return body;
  }

  protected ingest(files: SourceFile[], opts: AdapterOptions): void {
    for (const f of files) {
      assertPath(f.path);
      if (this.byPath.has(f.path)) throw new Error(`@ispeakllm/core: duplicate path ${f.path}`);
      const { frontmatter, body } = parseFrontmatter(f.raw, opts.parser);
      const title = this.titleFor(f.path, frontmatter, body);
      this.byPath.set(f.path, {
        ref: refFromFrontmatter(f.path, title, frontmatter, f.lastModified),
        body: this.prepareBody(body),
        frontmatter,
      });
    }
  }

  async list(): Promise<PageRef[]> {
    return [...this.byPath.values()].map((e) => e.ref);
  }

  async load(ref: PageRef): Promise<PageContent> {
    const entry = this.byPath.get(ref.path);
    if (!entry) throw new Error(`@ispeakllm/core: no file for path ${ref.path}`);
    return { ref: entry.ref, body: entry.body, frontmatter: entry.frontmatter };
  }
}

function humanise(path: string): string {
  if (path === "/") return "Home";
  const last = path.split("/").filter(Boolean).pop() ?? "Home";
  const words = last.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Plain Markdown files. Title: frontmatter `title`, else the first `# H1`, else the file name. */
export class FilesAdapter extends FrontmatterSource {
  constructor(files: SourceFile[], opts: AdapterOptions = {}) {
    super();
    this.ingest(files, opts);
  }
  protected titleFor(path: string, fm: Record<string, unknown>, body: string): string {
    const t = str(fm.title);
    if (t) return t;
    const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
    return h1?.[1] ?? humanise(path);
  }
}

/** MDX/Markdown with a required frontmatter `title` (a missing title throws). */
export class MdxAdapter extends FrontmatterSource {
  constructor(files: SourceFile[], opts: AdapterOptions = {}) {
    super();
    this.ingest(files, opts);
  }
  protected titleFor(path: string, fm: Record<string, unknown>): string {
    const t = fm.title;
    if (typeof t !== "string" || t.length === 0) {
      throw new Error(`@ispeakllm/core: page ${path} is missing a 'title' in frontmatter.`);
    }
    return t;
  }
  /** Drop top-level MDX `import`/`export` lines (outside code fences). */
  protected prepareBody(body: string): string {
    let fence = false;
    return body
      .split("\n")
      .filter((line) => {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (fence) return true;
        return !/^(import\s.+\sfrom\s.+|import\s+['"].+['"];?|export\s+(const|let|default|function)\s.*)$/.test(line.trim());
      })
      .join("\n");
  }
}

export type JsonEndpointPayload = { files: SourceFile[] };

/** Pure parse of a JSON document `{ files: [{ path, raw, lastModified? }] }` (fetching is the caller's job). */
export class JsonEndpointAdapter extends FrontmatterSource {
  constructor(payload: JsonEndpointPayload | string, opts: AdapterOptions = {}) {
    super();
    const data: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
    const files = (data as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) throw new Error("@ispeakllm/core: JSON endpoint payload must be { files: [...] }.");
    const checked = files.map((f, i): SourceFile => {
      const o = f as Partial<SourceFile> | null;
      if (!o || typeof o.path !== "string" || typeof o.raw !== "string") {
        throw new Error(`@ispeakllm/core: files[${i}] needs string 'path' and 'raw'.`);
      }
      return o.lastModified === undefined ? { path: o.path, raw: o.raw } : { path: o.path, raw: o.raw, lastModified: String(o.lastModified) };
    });
    this.ingest(checked, opts);
  }
  protected titleFor(path: string, fm: Record<string, unknown>, body: string): string {
    return str(fm.title) ?? /^#[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1] ?? humanise(path);
  }
}

/** Pages supplied programmatically (catalogue mode: build pages from a data catalogue). */
export class StaticSource implements ContentSource {
  private readonly byPath = new Map<string, PageContent>();
  constructor(pages: { ref: PageRef; body: string }[]) {
    for (const p of pages) {
      assertPath(p.ref.path);
      if (this.byPath.has(p.ref.path)) throw new Error(`@ispeakllm/core: duplicate path ${p.ref.path}`);
      this.byPath.set(p.ref.path, { ref: p.ref, body: p.body });
    }
  }
  async list(): Promise<PageRef[]> {
    return [...this.byPath.values()].map((c) => c.ref);
  }
  async load(ref: PageRef): Promise<PageContent> {
    const c = this.byPath.get(ref.path);
    if (!c) throw new Error(`@ispeakllm/core: no page for path ${ref.path}`);
    return c;
  }
}
