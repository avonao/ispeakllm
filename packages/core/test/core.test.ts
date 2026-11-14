import { describe, it, expect } from "vitest";
import {
  FilesAdapter,
  MdxAdapter,
  JsonEndpointAdapter,
  StaticSource,
  pathFromFile,
  generate,
  generateLocales,
  generateViews,
  exportCtx,
  toFiles,
  negotiate,
  linkHeaders,
  linkHeaderValue,
  etag,
  handleConditional,
  markdownHeaders,
  estimateTokens,
  buildAcmShell,
} from "../src/index";
import { loadFixture, golden } from "./helpers";

const OPTS = {
  title: "Acme Docs",
  summary: "Documentation for the Acme widget platform.",
  origin: "https://acme.example",
  sections: [
    { id: "getting-started", title: "Getting started", priority: 10 },
    { id: "reference", title: "Reference", priority: 5 },
  ],
};

const run = async () => generate(new FilesAdapter(loadFixture()), OPTS);

/** The llmstxt.org structure rules, checked on a rendered llms.txt. */
function checkStructure(txt: string): void {
  const lines = txt.split("\n");
  expect(lines[0]).toMatch(/^# \S/); // H1 first
  expect(lines.filter((l) => /^# /.test(l)).length).toBe(1); // exactly one H1
  expect(lines[1]).toBe("");
  expect(lines[2]).toMatch(/^> \S/); // blockquote summary
  expect(lines.some((l) => /^#{3,} /.test(l))).toBe(false); // only H2 below the H1
  const h2 = lines.filter((l) => /^## /.test(l));
  expect(h2.length).toBeGreaterThan(0);
  if (h2.includes("## Optional")) expect(h2[h2.length - 1]).toBe("## Optional"); // Optional is last
  for (const l of lines.filter((x) => x.startsWith("- "))) {
    expect(l).toMatch(/^- \[[^\]]+(?:\\\][^\]]*)*\]\([^)\s]+\)(: .+)?$/); // [name](url): notes
  }
  expect(txt.endsWith("\n") && !txt.endsWith("\n\n")).toBe(true);
  expect(txt.includes("\r")).toBe(false);
}

describe("fixture site: golden + determinism", () => {
  it("is byte-identical across two runs (and across input order)", async () => {
    const a = await run();
    const b = await run();
    const c = await generate(new FilesAdapter([...loadFixture()].reverse()), OPTS);
    expect(b.llmsTxt).toBe(a.llmsTxt);
    expect(b.llmsFullTxt).toBe(a.llmsFullTxt);
    expect(c.llmsTxt).toBe(a.llmsTxt);
    expect(c.llmsFullTxt).toBe(a.llmsFullTxt);
    expect(JSON.stringify(b.pages)).toBe(JSON.stringify(a.pages));
    expect(JSON.stringify(c.pages)).toBe(JSON.stringify(a.pages));
  });

  it("matches the golden files", async () => {
    const out = await run();
    expect(out.llmsTxt).toBe(golden("llms.txt", out.llmsTxt));
    expect(out.llmsFullTxt).toBe(golden("llms-full.txt", out.llmsFullTxt));
    const hashes = out.pages.map((p) => `${p.hash}  ${p.mdPath}`).join("\n") + "\n";
    expect(hashes).toBe(golden("page-hashes.txt", hashes));
  });

  it("passes the llmstxt.org structure rules", async () => {
    const out = await run();
    checkStructure(out.llmsTxt);
    expect(out.llmsTxt).toContain("## Optional\n\n- [Changelog](https://acme.example/docs/changelog.md): Release history.");
    expect(out.llmsTxt).toContain("[Acme Docs](https://acme.example/index.md)"); // page.md form for "/"
    expect(out.llmsTxt).toContain("[Hello world \\[launch\\]](https://acme.example/blog/hello.md)"); // escaped brackets
  });

  it("content hash is stable and changes only with the page content", async () => {
    const a = await run();
    const files = loadFixture().map((f) => (f.path === "/blog/hello" ? { ...f, raw: f.raw.replace("First post.", "Second post.") } : f));
    const b = await generate(new FilesAdapter(files), OPTS);
    const changed = b.pages.filter((p, i) => p.hash !== a.pages.find((q) => q.path === p.path)!.hash);
    expect(changed.map((p) => p.path)).toEqual(["/blog/hello"]);
  });

  it("rejects duplicate paths from a source", async () => {
    const src = new StaticSource([{ ref: { path: "/a", title: "A" }, body: "x" }]);
    const dup = { list: async () => [...(await src.list()), { path: "/a", title: "A2" }], load: (r: { path: string; title: string }) => src.load(r) };
    await expect(generate(dup, { title: "T" })).rejects.toThrow(/duplicate path/);
  });
});

describe("adapters", () => {
  it("FilesAdapter falls back to the H1, then the file name, for the title", async () => {
    const a = new FilesAdapter([
      { path: "/one", raw: "# From heading\n\nbody" },
      { path: "/two-words", raw: "no heading here" },
    ]);
    const refs = await a.list();
    expect(refs.map((r) => r.title)).toEqual(["From heading", "Two words"]);
  });

  it("maps file paths to site paths", () => {
    expect(pathFromFile("index.md")).toBe("/");
    expect(pathFromFile("docs/install.mdx")).toBe("/docs/install");
    expect(pathFromFile("docs/index.md")).toBe("/docs");
    expect(pathFromFile("/site/content/a/b.md", "/site/content")).toBe("/a/b");
    expect(pathFromFile("a\\b.md")).toBe("/a/b");
  });

  it("MdxAdapter drops import/export lines but keeps code fences intact", async () => {
    const a = new MdxAdapter([{ path: "/m", raw: "---\ntitle: M\n---\nimport X from './x'\nexport const meta = {}\n\nText\n\n```js\nimport a from 'b'\n```\n" }]);
    const c = await a.load((await a.list())[0]!);
    expect(c.body).not.toContain("import X");
    expect(c.body).not.toContain("export const");
    expect(c.body).toContain("import a from 'b'");
  });

  it("JsonEndpointAdapter parses { files: [...] } purely and validates the shape", async () => {
    const payload = { files: [{ path: "/a", raw: "---\ntitle: A\naudience: dev, ops\n---\nBody", lastModified: "2026-01-01T00:00:00Z" }] };
    const a = new JsonEndpointAdapter(JSON.stringify(payload));
    const [ref] = await a.list();
    expect(ref).toMatchObject({ path: "/a", title: "A", audience: ["dev", "ops"], lastModified: "2026-01-01T00:00:00Z" });
    expect(() => new JsonEndpointAdapter({} as never)).toThrow(/files/);
    expect(() => new JsonEndpointAdapter({ files: [{ path: "/x" }] } as never)).toThrow(/files\[0\]/);
  });
});

describe("locales", () => {
  const sources = () => ({
    en: new FilesAdapter(loadFixture()),
    de: new FilesAdapter(loadFixture("de")),
  });
  const opts = { ...OPTS, defaultLocale: "en", localeOptions: { de: { title: "Acme Dokumentation", summary: "Dokumentation der Acme-Plattform." } }, localeNames: { en: "English", de: "Deutsch" } };

  it("emits per-locale files and alternates", async () => {
    const r = await generateLocales(sources(), opts);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("/llms.txt");
    expect(paths).toContain("/de/llms.txt");
    expect(paths).toContain("/de/llms-full.txt");
    expect(paths).toContain("/de/install.md");
    expect(paths).toContain("/de/index.md");
    expect(paths).toContain("/docs/install.md");
    const de = r.locales.de!;
    expect(de.llmsTxt).toContain("# Acme Dokumentation");
    expect(de.llmsTxt).toContain("[Installation](https://acme.example/de/install.md)");
    expect(de.llmsTxt).toContain("## Languages\n\n- [English](https://acme.example/llms.txt): alternate (en) llms.txt");
    expect(r.locales.en!.llmsTxt).toContain("[Deutsch](https://acme.example/de/llms.txt): alternate (de) llms.txt");
    expect(de.alternates).toEqual([{ locale: "en", name: "English", llmsTxtPath: "/llms.txt" }]);
    checkStructure(de.llmsTxt);
    checkStructure(r.locales.en!.llmsTxt);
  });

  it("is deterministic and golden-stable", async () => {
    const a = await generateLocales(sources(), opts);
    const b = await generateLocales(sources(), opts);
    expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
    const dump = a.files.map((f) => `=== ${f.path}\n${f.content}`).join("\n");
    expect(dump).toBe(golden("locales.txt", dump));
  });

  it("rejects a defaultLocale without a source", async () => {
    await expect(generateLocales(sources(), { ...opts, defaultLocale: "fr" })).rejects.toThrow(/defaultLocale/);
  });

  it("negotiate understands locale prefixes", () => {
    expect(negotiate({ pathname: "/de/llms.txt", locales: ["de"] })).toEqual({ variant: "llmstxt", locale: "de" });
    expect(negotiate({ pathname: "/de/install.md", locales: ["de"] })).toEqual({ variant: "md", pagePath: "/de/install", locale: "de" });
    expect(negotiate({ pathname: "/de/install", accept: "text/markdown", locales: ["de"] })).toEqual({ variant: "md", pagePath: "/de/install", locale: "de" });
  });
});

describe("audience views", () => {
  it("filters by audience (untagged pages stay) and by sections", async () => {
    const src = new FilesAdapter(loadFixture());
    const dev = await generate(src, { ...OPTS, view: { audience: "developers" } });
    const paths = dev.pages.map((p) => p.path);
    expect(paths).toContain("/docs/api");
    expect(paths).not.toContain("/docs/admin");
    expect(paths).toContain("/docs/install");
    const ref = await generate(src, { ...OPTS, view: { sections: ["reference"] } });
    expect(ref.pages.map((p) => p.path).sort()).toEqual(["/docs/admin", "/docs/api"]);
  });

  it("generateViews emits /views/<name>/ files", async () => {
    const r = await generateViews(new FilesAdapter(loadFixture()), OPTS, {
      admins: { audience: "admins", title: "Acme for admins" },
      developers: { audience: "developers" },
    });
    expect(r.files.map((f) => f.path)).toEqual(["/views/admins/llms-full.txt".replace("llms-full", "llms"), "/views/admins/llms-full.txt", "/views/developers/llms.txt", "/views/developers/llms-full.txt"]);
    expect(r.views.admins!.llmsTxt).toContain("# Acme for admins");
    expect(r.views.admins!.llmsTxt).toContain("Administration");
    expect(r.views.admins!.llmsTxt).not.toContain("API reference");
    checkStructure(r.views.admins!.llmsTxt);
  });
});

describe("llms-ctx export + token budget", () => {
  it("estimateTokens is ceil(bytes/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("éé")).toBe(1); // 4 bytes
  });

  it("exports sections, hides Optional unless asked, and escapes attributes", async () => {
    const out = await run();
    const ctx = exportCtx(out, {}, "https://acme.example");
    expect(ctx.text.startsWith('<project title="Acme Docs" summary="Documentation for the Acme widget platform.">')).toBe(true);
    expect(ctx.text).toContain('<section name="Getting started">');
    expect(ctx.text).not.toContain("<optional>");
    expect(ctx.omitted).toContain("/docs/changelog");
    const full = exportCtx(out, { includeOptional: true });
    expect(full.text).toContain("<optional>");
    expect(full.omitted).toEqual([]);
    expect(full.text).toContain("Initial release.");
  });

  it("never exceeds the budget and keeps whole documents", async () => {
    const out = await run();
    const all = exportCtx(out, { includeOptional: true });
    for (const budget of [all.tokens, Math.floor(all.tokens / 2), 120, 40]) {
      const r = exportCtx(out, { includeOptional: true, budgetTokens: budget });
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(Math.max(budget, estimateTokens('<project title="Acme Docs" summary="Documentation for the Acme widget platform.">\n</project>\n')));
      expect(r.included.length + r.omitted.length).toBe(out.pages.length);
      expect((r.text.match(/<doc /g) ?? []).length).toBe(r.included.length);
    }
    expect(exportCtx(out, { includeOptional: true, budgetTokens: all.tokens }).truncated).toBe(false);
    expect(exportCtx(out, { includeOptional: true, budgetTokens: 120 }).truncated).toBe(true);
  });
});

describe("negotiate(): q-values and suffix", () => {
  const n = (accept: string | null | undefined, pathname = "/about") => negotiate({ pathname, accept }).variant;
  it("md for Accept: text/markdown", () => {
    expect(negotiate({ pathname: "/about", accept: "text/markdown" })).toEqual({ variant: "md", pagePath: "/about" });
    expect(negotiate({ pathname: "/docs/", accept: "text/markdown" }).pagePath).toBe("/docs");
  });
  it("html for a browser Accept", () => {
    expect(n("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")).toBe("html");
    expect(n("*/*")).toBe("html");
    expect(n(null)).toBe("html");
  });
  it("md for the .md suffix, whatever the Accept", () => {
    expect(negotiate({ pathname: "/about.md", accept: "text/html" })).toEqual({ variant: "md", pagePath: "/about" });
    expect(negotiate({ pathname: "/index.md" })).toEqual({ variant: "md", pagePath: "/" });
    expect(negotiate({ pathname: "/docs/index.md" }).pagePath).toBe("/docs");
  });
  it("honours markdown only when html is not preferred", () => {
    expect(n("text/markdown, text/html;q=0.5")).toBe("md");
    expect(n("text/html, text/markdown;q=0.5")).toBe("html");
    expect(n("text/html;q=0.9, text/markdown;q=0.9")).toBe("html"); // tie: html listed first
    expect(n("text/markdown, text/html")).toBe("md"); // tie: markdown listed first
    expect(n("text/markdown;q=0, text/html")).toBe("html");
    expect(n("text/markdown, */*;q=0.1")).toBe("md");
    expect(n("*/*, text/markdown")).toBe("html"); // wildcard listed first at equal q
  });
  it("wildcards never select markdown or ACM", () => {
    expect(n("text/*")).toBe("html");
    expect(n("*/*;q=1")).toBe("html");
  });
  it("ACM wins ties and is selected by explicit Accept", () => {
    expect(n("application/ai-conformance+json", "/")).toBe("acm");
    expect(n("text/html;q=0.5, application/ai-conformance+json", "/")).toBe("acm");
    expect(n("text/markdown, application/ai-conformance+json")).toBe("acm");
    expect(n("text/html, application/ai-conformance+json;q=0.1")).toBe("html");
  });
});

describe("HTTP helpers", () => {
  it("linkHeaders: alternate markdown + describedby llms.txt", () => {
    const l = linkHeaders({ pathname: "/docs/install", origin: "https://acme.example" });
    expect(l).toEqual([
      '<https://acme.example/docs/install.md>; rel="alternate"; type="text/markdown"',
      '<https://acme.example/llms.txt>; rel="describedby"; type="text/markdown"',
    ]);
    expect(linkHeaders({ pathname: "/" })[0]).toBe('</index.md>; rel="alternate"; type="text/markdown"');
    expect(linkHeaderValue({ pathname: "/a", llmsTxtPath: false })).toBe('</a.md>; rel="alternate"; type="text/markdown"');
    const loc = linkHeaders({ pathname: "/de/install", llmsTxtPath: "/de/llms.txt", alternates: [{ locale: "en", href: "/docs/install" }] });
    expect(loc).toContain('</de/llms.txt>; rel="describedby"; type="text/markdown"');
    expect(loc).toContain('</docs/install>; rel="alternate"; hreflang="en"');
  });

  it("markdownHeaders: content type, Vary, token count, ETag", async () => {
    const body = "# T\n\nhello world, this is a page.\n";
    const h = await markdownHeaders(body, { lastModified: "2026-06-15T00:00:00Z" });
    expect(h["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(h.Vary).toBe("Accept");
    expect(h["x-markdown-tokens"]).toBe(String(estimateTokens(body)));
    expect(h.ETag).toBe(await etag(body));
    expect(h.ETag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(h["Last-Modified"]).toBe("Mon, 15 Jun 2026 00:00:00 GMT");
  });

  it("etag is stable and content-sensitive", async () => {
    expect(await etag("a")).toBe(await etag("a"));
    expect(await etag("a")).not.toBe(await etag("b"));
    expect(await etag(new TextEncoder().encode("a"))).toBe(await etag("a"));
  });

  it("a matching If-None-Match yields 304", async () => {
    const tag = await etag("body");
    const hit = handleConditional({ "If-None-Match": tag }, tag);
    expect(hit?.status).toBe(304);
    expect(hit?.headers.ETag).toBe(tag);
    expect(handleConditional(new Headers({ "if-none-match": `"zzz", W/${tag}` }), tag)?.status).toBe(304);
    expect(handleConditional({ "if-none-match": "*" }, tag)?.status).toBe(304);
    expect(handleConditional({ "if-none-match": '"other"' }, tag)).toBeNull();
    expect(handleConditional({}, tag)).toBeNull();
  });

  it("If-Modified-Since is honoured only without If-None-Match", async () => {
    const tag = await etag("body");
    const lm = "2026-06-15T00:00:00Z";
    expect(handleConditional({ "if-modified-since": "Mon, 15 Jun 2026 00:00:00 GMT" }, tag, lm)?.status).toBe(304);
    expect(handleConditional({ "if-modified-since": "Sun, 14 Jun 2026 00:00:00 GMT" }, tag, lm)).toBeNull();
    expect(handleConditional({ "if-none-match": '"x"', "if-modified-since": "Mon, 15 Jun 2026 00:00:00 GMT" }, tag, lm)).toBeNull();
  });

  it("toFiles lists index files and every page", async () => {
    const out = await run();
    const paths = toFiles(out).map((f) => f.path);
    expect(paths.slice(0, 2)).toEqual(["/llms.txt", "/llms-full.txt"]);
    expect(paths).toContain("/docs/api.md");
    expect(paths.length).toBe(2 + out.pages.length);
  });
});

describe("ACM shell from the fixture", () => {
  it("is deterministic and carries per-page hashes", async () => {
    const mk = async () => buildAcmShell({ domain: "acme.example", issuer: { name: "Acme" }, issued_at: "2026-06-15T00:00:00.000Z", ai_disclosure: { systems: [] }, outputs: await run(), origin: "https://acme.example", sections: OPTS.sections });
    const a = await mk();
    expect(JSON.stringify(await mk())).toBe(JSON.stringify(a));
    const home = a.content_map.pages.find((p) => p.path === "/")!;
    expect(home.md_url).toBe("https://acme.example/index.md");
    expect(home.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
