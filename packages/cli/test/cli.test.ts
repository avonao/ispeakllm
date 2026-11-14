import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, createStaticHandler, type Io } from "../src/index";

const NOW = new Date("2026-11-14T00:00:00Z");
let dir: string;
let lines: string[];
const io = (): Io => ({ cwd: dir, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), now: () => NOW });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ispeakllm-cli-"));
  lines = [];
});

const decl = {
  domain: "example.com",
  defaults: [
    { subject: "index", stance: "allow" },
    { subject: "train", stance: "deny" },
  ],
};

describe("cli", () => {
  it("init then generate writes llms.txt, page md, ACM and lints clean", async () => {
    expect(await run(["init"], io())).toBe(0);
    await writeFile(join(dir, "content", "about.md"), "---\ntitle: About\nsummary: Who we are.\n---\n\n# About\n\nWe make widgets.\n");
    expect(await run(["generate"], io())).toBe(0);
    const llms = await readFile(join(dir, "public", "llms.txt"), "utf8");
    expect(llms).toMatch(/^# My site/);
    expect(llms).toContain("about.md");
    expect(await readFile(join(dir, "public", "about.md"), "utf8")).toContain("We make widgets.");
    const acm = JSON.parse(await readFile(join(dir, "public", ".well-known", "ai-conformance.json"), "utf8"));
    expect(acm.provenance).toBeUndefined();
    expect(lines.join("\n")).toMatch(/unsigned/);
    expect(await run(["lint", "public/llms.txt"], io())).toBe(0);
  });

  it("keys + generate signs the manifest, verify accepts it and rejects tampering", async () => {
    await run(["init"], io());
    expect(await run(["keys"], io())).toBe(0);
    expect((await stat(join(dir, ".ispeakllm", "signing-key.json"))).mode & 0o777).toBe(0o600);
    expect(await run(["keys"], io())).toBe(1); // refuses to overwrite
    await run(["generate"], io());
    const acmPath = "public/.well-known/ai-conformance.json";
    expect(await run(["verify", acmPath, "--jwks", "public/.well-known/jwks.json"], io())).toBe(0);
    const acm = JSON.parse(await readFile(join(dir, acmPath), "utf8"));
    acm.domain = "evil.example";
    await writeFile(join(dir, acmPath), JSON.stringify(acm));
    expect(await run(["verify", acmPath, "--jwks", "public/.well-known/jwks.json"], io())).toBe(1);
  });

  it("sign + verify a detached file", async () => {
    await run(["keys"], io());
    await writeFile(join(dir, "note.txt"), "hello");
    expect(await run(["sign", "note.txt"], io())).toBe(0);
    expect(await run(["verify", "note.txt", "--key", ".ispeakllm/signing-key.public.json"], io())).toBe(0);
    await writeFile(join(dir, "note.txt"), "hellO");
    expect(await run(["verify", "note.txt", "--key", ".ispeakllm/signing-key.public.json"], io())).toBe(1);
  });

  it("policy files are generated and an existing robots.txt is never overwritten", async () => {
    await run(["init"], io());
    await writeFile(join(dir, "decl.json"), JSON.stringify(decl));
    const cfg = JSON.parse(await readFile(join(dir, "ispeakllm.config.json"), "utf8"));
    await writeFile(join(dir, "ispeakllm.config.json"), JSON.stringify({ ...cfg, policy: "decl.json" }));
    await mkdir(join(dir, "public"), { recursive: true });
    await writeFile(join(dir, "public", "robots.txt"), "User-agent: *\nAllow: /\n");
    expect(await run(["generate"], io())).toBe(0);
    expect(await readFile(join(dir, "public", "robots.txt"), "utf8")).toBe("User-agent: *\nAllow: /\n");
    expect(await readFile(join(dir, "public", "robots.ispeakllm.txt"), "utf8")).toContain("Content-Signal");
    expect(await readFile(join(dir, "public", "ai.txt"), "utf8")).toBeTruthy();
    const corpus = JSON.parse(await readFile(join(dir, "public", ".well-known", "ispeakllm-corpus.json"), "utf8"));
    expect(corpus.policy["Content-Signal"]).toMatch(/ai-train=no/);
  });

  it("lint reports errors with exit 1; unknown command exits 2", async () => {
    await writeFile(join(dir, "bad.txt"), "no heading here\n");
    expect(await run(["lint", "bad.txt"], io())).toBe(1);
    expect(await run(["frobnicate"], io())).toBe(2);
    expect(await run(["generate"], io())).toBe(2); // no config
  });

  it("check uses the given fetch only", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const code = await run(["check", "https://example.com"], { ...io(), fetch: fake });
    expect(code).toBe(1);
    expect(seen.every((u) => u.startsWith("https://example.com"))).toBe(true);
  });

  it("static handler negotiates markdown, sets Vary, honours ETag", async () => {
    await run(["init"], io());
    await run(["generate"], io());
    await writeFile(join(dir, "public", "index.html"), "<h1>Home</h1>");
    const h = createStaticHandler(join(dir, "public"));
    const html = await h(new Request("http://x/"));
    expect(html.headers.get("content-type")).toMatch(/text\/html/);
    expect(html.headers.get("link")).toMatch(/text\/markdown/);
    const md = await h(new Request("http://x/", { headers: { accept: "text/markdown" } }));
    expect(md.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(md.headers.get("vary")).toBe("Accept");
    const again = await h(new Request("http://x/", { headers: { accept: "text/markdown", "if-none-match": md.headers.get("etag")! } }));
    expect(again.status).toBe(304);
    expect((await h(new Request("http://x/../../etc/passwd"))).status).toBe(404);
    expect((await h(new Request("http://x/llms.txt"))).headers.get("x-markdown-tokens")).toBeTruthy();
  });
});
