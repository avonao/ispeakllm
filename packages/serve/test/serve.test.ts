import { describe, it, expect } from "vitest";
import { StaticSource, generate, toFiles } from "@ispeakllm/core";
import { renderPolicySet } from "@ispeakllm/policy";
import { createAgentHandler, makeBundle, decorateHtml, type Bundle, type FetchEvent } from "../src/index";

const declaration = { domain: "example.com", defaults: [{ subject: "index", stance: "allow" }, { subject: "train", stance: "deny" }] };

async function bundle(): Promise<Bundle> {
  const src = new StaticSource([
    { ref: { path: "/", title: "Home", summary: "Welcome" }, body: "# Home\n\nWelcome to Acme." },
    { ref: { path: "/pricing", title: "Pricing" }, body: "# Pricing\n\nFive euros." },
  ]);
  const out = await generate(src, { title: "Acme", summary: "Widgets", origin: "https://example.com" });
  const set = renderPolicySet(declaration);
  const files = [
    ...toFiles(out),
    ...set.artifacts.map((a) => ({ path: a.path, content: a.body, contentType: a.contentType })),
    { path: "/.well-known/ai-conformance.json", content: '{"spec_version":"1"}', contentType: "application/ai-conformance+json" },
  ];
  return makeBundle({
    files,
    corpus: { siteName: "Acme", pages: out.pages.map((p) => ({ path: p.path, title: p.path, md: p.md })) },
    origin: "https://example.com",
    declaration,
    generatedAt: "2026-11-14T00:00:00Z",
  });
}

const htmlUpstream = async (req: Request) =>
  new URL(req.url).pathname === "/blog"
    ? new Response("<html><head><title>Blog</title></head><body><nav>menu</nav><main><h1>Blog</h1><p>Post one.</p></main></body></html>", { headers: { "content-type": "text/html" } })
    : new Response("<html><body><h1>Page</h1></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });

describe("serve", () => {
  it("serves page markdown on Accept and on .md, with Vary, tokens, policy headers and 304", async () => {
    const h = createAgentHandler({ bundle: await bundle() });
    const r = (await h.handle(new Request("https://example.com/pricing", { headers: { accept: "text/markdown" } })))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(r.headers.get("vary")).toBe("Accept");
    expect(Number(r.headers.get("x-markdown-tokens"))).toBeGreaterThan(0);
    expect(r.headers.get("content-signal")).toMatch(/ai-train=no/);
    expect(await r.text()).toContain("Five euros");
    const md = (await h.handle(new Request("https://example.com/pricing.md")))!;
    expect(md.status).toBe(200);
    const again = (await h.handle(new Request("https://example.com/pricing.md", { headers: { "if-none-match": md.headers.get("etag")! } })))!;
    expect(again.status).toBe(304);
    expect((await h.handle(new Request("https://example.com/llms.txt")))!.headers.get("content-type")).toMatch(/markdown/);
    expect(await (await h.handle(new Request("https://example.com/robots.txt")))!.text()).toContain("Content-Signal");
  });

  it("leaves human HTML to the host and decorates it without changing the body", async () => {
    const b = await bundle();
    const h = createAgentHandler({ bundle: b, upstream: htmlUpstream });
    expect(await h.handle(new Request("https://example.com/pricing"))).toBeNull();
    const r = await h.fetch(new Request("https://example.com/pricing"));
    expect(await r.text()).toBe("<html><body><h1>Page</h1></body></html>");
    expect(r.headers.get("link")).toMatch(/pricing\.md/);
    expect(r.headers.get("vary")).toMatch(/Accept/);
    const d = await decorateHtml(b, new Request("https://example.com/"), new Response("<p>x</p>", { headers: { "content-type": "text/html", vary: "Cookie" } }));
    expect(d.headers.get("vary")).toBe("Cookie, Accept");
  });

  it("converts upstream HTML when no source markdown exists, and says so", async () => {
    const h = createAgentHandler({ bundle: await bundle(), upstream: htmlUpstream });
    const r = (await h.handle(new Request("https://example.com/blog", { headers: { accept: "text/markdown" } })))!;
    expect(r.headers.get("x-ispeakllm-source")).toBe("html-fallback");
    const text = await r.text();
    expect(text).toContain("Post one.");
    expect(text).not.toContain("menu");
    const none = createAgentHandler({ bundle: await bundle() });
    expect((await none.handle(new Request("https://example.com/blog.md")))!.status).toBe(404);
  });

  it("MCP endpoint and server card", async () => {
    const h = createAgentHandler({ bundle: await bundle() });
    const r = (await h.handle(new Request("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })))!;
    expect((await r.json()).result.tools.length).toBe(4);
    const card = await (await h.handle(new Request("https://example.com/.well-known/mcp.json")))!.json();
    expect(card.transport.url).toBe("https://example.com/mcp");
  });

  it("fetch log: a spoofed GPTBot is unauthenticated, never attributed, IP only hashed", async () => {
    const events: FetchEvent[] = [];
    const h = createAgentHandler({ bundle: await bundle(), fetchLog: { ipSalt: "0123456789abcdef-salt" }, onFetch: (e) => void events.push(e), now: () => new Date("2026-11-14T00:00:00Z") });
    await h.handle(new Request("https://example.com/pricing.md", { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)", "cf-connecting-ip": "20.15.240.64" } }));
    const rec = events[0]!.record!;
    expect(rec.grade).toBe("unauthenticated");
    expect(rec.operator).toBeNull();
    expect(rec.claimedAgent).toBeTruthy();
    expect(JSON.stringify(rec)).not.toContain("20.15.240.64");
    expect(rec.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    await h.handle(new Request("https://example.com/pricing.md", { headers: { "user-agent": "Mozilla/5.0 Safari" } }));
    expect(events[1]!.record).toBeUndefined();
  });
});
