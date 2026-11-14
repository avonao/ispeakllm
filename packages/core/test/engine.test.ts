// Ported from llms-txt/test/engine.test.ts (goplainly-v6-2026-11-10-current-dormant); D1 adapter tests dropped (D1 is not part of this package)
import { describe, it, expect } from "vitest";
import {
  MdxAdapter,
  parseFrontmatter,
  parseYamlLite,
  generate,
  renderLlmsTxt,
  renderPageMarkdown,
  sortPages,
  negotiate,
  buildAcmShell,
  ACM_SPEC_VERSION,
  type GeneratedOutputs,
  type MdxFile,
} from "../src/index";

const HOME: MdxFile = { path: "/", raw: "---\ntitle: Welcome\nsummary: The home page.\n---\n\n# Welcome\n\nHello." };
const ABOUT: MdxFile = { path: "/about", raw: "---\ntitle: About us\nsection: company\npriority: 5\n---\n\nWe make trust primitives." };
const POST: MdxFile = { path: "/blog/hello", raw: "---\ntitle: Hello world\nsection: blog\n---\n\nFirst post." };

describe("parseFrontmatter (YAML-lite)", () => {
  it("returns the body unchanged when there is no frontmatter", () => {
    const r = parseFrontmatter("# Just markdown\n\nhi.");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Just markdown\n\nhi.");
  });

  it("parses scalar string/number/boolean/null + strips quotes + trailing comments", () => {
    const fm = parseYamlLite(['title: "Hello"', "priority: 10", "draft: false", "tag: ~", "section: company  # inline comment", "# whole-line comment"].join("\n"));
    expect(fm.title).toBe("Hello");
    expect(fm.priority).toBe(10);
    expect(fm.draft).toBe(false);
    expect(fm.tag).toBeNull();
    expect(fm.section).toBe("company");
  });

  it("parses inline lists", () => {
    expect(parseYamlLite("audience: [developers, 'ops']").audience).toEqual(["developers", "ops"]);
  });

  it("extracts frontmatter + body from a `---`-fenced doc", () => {
    const r = parseFrontmatter("---\ntitle: T\n---\n\nbody here\n");
    expect(r.frontmatter).toEqual({ title: "T" });
    expect(r.body).toBe("\nbody here\n");
  });

  it("returns body unchanged when the closing fence is missing", () => {
    expect(parseFrontmatter("---\ntitle: T\nno closing fence").frontmatter).toEqual({});
  });
});

describe("MdxAdapter", () => {
  it("requires title in frontmatter", () => {
    expect(() => new MdxAdapter([{ path: "/x", raw: "no fm" }])).toThrow(/missing a 'title'/);
  });

  it("requires absolute paths", () => {
    expect(() => new MdxAdapter([{ path: "x", raw: "---\ntitle: T\n---\n" }])).toThrow(/must start with '\/'/);
  });

  it("loads pages with their frontmatter + body", async () => {
    const a = new MdxAdapter([HOME, ABOUT]);
    const refs = await a.list();
    expect(refs.map((r) => r.path).sort()).toEqual(["/", "/about"]);
    const c = await a.load(refs.find((r) => r.path === "/about")!);
    expect(c.ref.title).toBe("About us");
    expect(c.ref.section).toBe("company");
    expect(c.ref.priority).toBe(5);
    expect(c.body.trim()).toBe("We make trust primitives.");
  });
});

describe("sortPages (deterministic)", () => {
  it("orders by -priority, then section, then path", () => {
    const order = sortPages([
      { path: "/c", priority: 0 },
      { path: "/a", priority: 10, section: "x" },
      { path: "/b", priority: 10, section: "x" },
      { path: "/d", priority: 5, section: "y" },
    ]).map((r) => r.path);
    expect(order).toEqual(["/a", "/b", "/d", "/c"]);
  });
});

describe("renderPageMarkdown", () => {
  it("emits title (+ optional summary) header, blank line, then body", () => {
    expect(renderPageMarkdown({ ref: { path: "/", title: "T", summary: "S" }, body: "Body.\n\n" })).toBe("# T\n> S\n\nBody.\n");
  });
});

describe("generate(): the three renderings", () => {
  it("produces per-page md, llms.txt, llms-full.txt", async () => {
    const out = await generate(new MdxAdapter([HOME, ABOUT, POST]), { title: "Acme", summary: "Our docs.", origin: "https://acme.example" });
    expect(out.pages.length).toBe(3);
    for (const p of out.pages) {
      expect(p.md).toMatch(/^# /);
      expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(out.llmsTxt).toContain("# Acme");
    expect(out.llmsTxt).toContain("> Our docs.");
    expect(out.llmsTxt).toContain("[About us](https://acme.example/about.md)");
    expect(out.llmsFullTxt).toContain("# Welcome");
    expect(out.llmsFullTxt).toContain("# About us");
    expect(out.llmsFullTxt).toContain("---");
  });

  it("is DETERMINISTIC: identical input gives identical bytes", async () => {
    const a = await generate(new MdxAdapter([HOME, ABOUT, POST]), { title: "Acme" });
    const b = await generate(new MdxAdapter([POST, ABOUT, HOME]), { title: "Acme" });
    expect(b.llmsTxt).toBe(a.llmsTxt);
    expect(b.llmsFullTxt).toBe(a.llmsFullTxt);
    expect(b.pages.map((p) => p.hash)).toEqual(a.pages.map((p) => p.hash));
  });

  it("renderLlmsTxt groups by declared sections, then seen sections, then orphans", () => {
    const txt = renderLlmsTxt(
      [
        { path: "/a", title: "A", section: "company", priority: 1 },
        { path: "/b", title: "B", section: "blog" },
        { path: "/c", title: "C" },
      ],
      { title: "Site", sections: [{ id: "company", title: "About the company", priority: 10 }] },
    );
    const lines = txt.split("\n");
    const idxCompany = lines.indexOf("## About the company");
    const idxBlog = lines.indexOf("## blog");
    const idxPages = lines.indexOf("## Pages");
    expect(idxCompany).toBeGreaterThan(0);
    expect(idxBlog).toBeGreaterThan(idxCompany);
    expect(idxPages).toBeGreaterThan(idxBlog);
  });

  it("does not mutate the caller's sections array", () => {
    const sections = [
      { id: "a", title: "A", priority: 1 },
      { id: "b", title: "B", priority: 9 },
    ];
    renderLlmsTxt([{ path: "/x", title: "X", section: "a" }], { title: "S", sections });
    expect(sections.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("negotiate() (ported cases)", () => {
  it("routes explicit paths first", () => {
    expect(negotiate({ pathname: "/llms.txt" }).variant).toBe("llmstxt");
    expect(negotiate({ pathname: "/llms-full.txt" }).variant).toBe("llmsfull");
    expect(negotiate({ pathname: "/.well-known/ai-conformance.json" }).variant).toBe("acm");
    const md = negotiate({ pathname: "/posts/hello.md" });
    expect(md.variant).toBe("md");
    expect(md.pagePath).toBe("/posts/hello");
  });

  it("honours Accept: text/markdown and application/ai-conformance+json", () => {
    expect(negotiate({ pathname: "/about", accept: "text/markdown" })).toEqual({ variant: "md", pagePath: "/about" });
    expect(negotiate({ pathname: "/", accept: "application/ai-conformance+json" }).variant).toBe("acm");
    expect(negotiate({ pathname: "/", accept: "text/markdown, application/ai-conformance+json" }).variant).toBe("acm");
  });

  it("defaults to html so the caller serves the normal page", () => {
    expect(negotiate({ pathname: "/", accept: "text/html" }).variant).toBe("html");
    expect(negotiate({ pathname: "/about" }).variant).toBe("html");
  });
});

describe("buildAcmShell()", () => {
  it("builds an unsigned, structured manifest payload (no provenance)", async () => {
    const out: GeneratedOutputs = await generate(new MdxAdapter([HOME, ABOUT]), { title: "Acme" });
    const shell = buildAcmShell({
      domain: "acme.example",
      issuer: { name: "Acme" },
      issued_at: "2026-06-15T00:00:00.000Z",
      ai_disclosure: { systems: [{ id: "support-bot", category: "conversational_ai", purpose: "Q&A" }] },
      consent: { config_ref: "https://api.acme.example/banner/pk_x", categories: ["necessary", "marketing"] },
      outputs: out,
      origin: "https://acme.example",
    });
    expect(shell.spec_version).toBe(ACM_SPEC_VERSION);
    expect(shell.domain).toBe("acme.example");
    expect(shell.content_source).toBe("source-connected");
    expect(shell.content_map.pages.length).toBe(2);
    expect(shell.content_map.pages[0]!.md_url).toMatch(/^https:\/\/acme\.example\//);
    expect(shell.content_map.pages[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(shell.consent?.categories).toContain("necessary");
    expect("provenance" in shell).toBe(false);
    expect(JSON.stringify(shell)).not.toContain("undefined");
  });
});

describe("dogfood: end-to-end on a fixture", () => {
  it("renders a small site to all four artifacts; outputs are deterministic + content-hash-stable", async () => {
    const files: MdxFile[] = [
      { path: "/", raw: "---\ntitle: Home\nsummary: Welcome to the docs.\n---\n\nHello world." },
      { path: "/install", raw: "---\ntitle: Install\nsection: getting-started\npriority: 100\n---\n\n```bash\nnpm i @ispeakllm/core\n```" },
      { path: "/api/generate", raw: "---\ntitle: generate()\nsection: api\npriority: 50\n---\n\nThe deterministic renderer." },
      { path: "/api/negotiate", raw: "---\ntitle: negotiate()\nsection: api\npriority: 49\n---\n\nThe content-negotiation helper." },
    ];
    const opts = {
      title: "@ispeakllm/core",
      summary: "Open-source publishing engine for llms.txt + ACM.",
      origin: "https://example.org",
      sections: [
        { id: "getting-started", title: "Getting started", priority: 10 },
        { id: "api", title: "API reference", priority: 5 },
      ],
    };
    const out = await generate(new MdxAdapter(files), opts);
    expect(out.pages.length).toBe(4);
    expect(new Set(out.pages.map((p) => p.hash)).size).toBe(4);

    const txt = out.llmsTxt;
    const idxGS = txt.indexOf("## Getting started");
    const idxApi = txt.indexOf("## API reference");
    const idxPages = txt.indexOf("## Pages");
    expect(idxGS).toBeGreaterThan(0);
    expect(idxApi).toBeGreaterThan(idxGS);
    expect(idxPages).toBeGreaterThan(idxApi);
    expect(txt).toContain("[Install](https://example.org/install.md)");

    expect(out.llmsFullTxt).toContain("npm i @ispeakllm/core");
    expect(out.llmsFullTxt.split("\n---\n").length - 1).toBeGreaterThanOrEqual(3);

    const shell = buildAcmShell({
      domain: "example.org",
      issuer: { name: "Example" },
      issued_at: "2026-06-15T00:00:00.000Z",
      ai_disclosure: { systems: [] },
      outputs: out,
      origin: "https://example.org",
      sections: opts.sections,
    });
    expect(shell.content_map.sections?.map((s) => s.id)).toEqual(["getting-started", "api"]);
    expect(shell.content_map.pages.every((p) => p.content_hash && p.md_url)).toBe(true);

    const out2 = await generate(new MdxAdapter([...files].reverse()), opts);
    expect(out2.llmsTxt).toBe(out.llmsTxt);
    expect(out2.llmsFullTxt).toBe(out.llmsFullTxt);
    expect(out2.pages.map((p) => p.hash)).toEqual(out.pages.map((p) => p.hash));
  });
});
