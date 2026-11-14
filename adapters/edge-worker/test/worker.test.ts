import { describe, it, expect, vi, afterEach } from "vitest";
import { makeBundle } from "@ispeakllm/serve";
import { createWorker } from "../src/index";

const bundle = makeBundle({
  files: [
    { path: "/llms.txt", content: "# Acme\n\n> Widgets\n\n## Pages\n\n- [Home](/index.md)\n", contentType: "text/markdown; charset=utf-8" },
    { path: "/index.md", content: "# Home\n\nHello.\n", contentType: "text/markdown; charset=utf-8" },
  ],
  corpus: { siteName: "Acme", pages: [{ path: "/", title: "Home", md: "# Home\n\nHello.\n" }] },
  origin: "https://example.com",
  generatedAt: "2026-11-14T00:00:00Z",
});

afterEach(() => vi.unstubAllGlobals());

describe("edge-worker", () => {
  it("answers agents from the bundle and proxies humans to the upstream with headers added", async () => {
    const upstream = vi.fn(async (req: Request) => new Response(`<h1>${new URL(req.url).pathname}</h1>`, { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", upstream);
    const w = createWorker(bundle);
    const md = await w.fetch(new Request("https://example.com/", { headers: { accept: "text/markdown" } }), { ISPEAKLLM_UPSTREAM: "https://origin.example.com" });
    expect(await md.text()).toContain("Hello.");
    expect(upstream).not.toHaveBeenCalled();
    const html = await w.fetch(new Request("https://example.com/"), { ISPEAKLLM_UPSTREAM: "https://origin.example.com" });
    expect(await html.text()).toBe("<h1>/</h1>");
    expect(String(upstream.mock.calls[0]![0].url)).toBe("https://origin.example.com/");
    expect(html.headers.get("link")).toMatch(/index\.md/);
  });

  it("stores graded agent fetches in KV via waitUntil, never the raw IP", async () => {
    const kv = new Map<string, string>();
    const waits: Promise<unknown>[] = [];
    const w = createWorker(bundle);
    await w.fetch(
      new Request("https://example.com/llms.txt", { headers: { "user-agent": "ClaudeBot/1.0", "cf-connecting-ip": "203.0.113.9" } }),
      { ISPEAKLLM_IP_SALT: "a-long-enough-salt", FETCH_LOG: { put: async (k, v) => void kv.set(k, v) } },
      { waitUntil: (p) => void waits.push(p) },
    );
    await Promise.all(waits);
    expect(kv.size).toBe(1);
    const [key, line] = [...kv.entries()][0]!;
    expect(key).toMatch(/^fetch\/\d{4}-\d{2}-\d{2}\//);
    expect(JSON.parse(line).grade).toBe("unauthenticated");
    expect(line).not.toContain("203.0.113.9");
  });
});
