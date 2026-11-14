import { describe, it, expect } from "vitest";
import { lintLlmsTxt, checkReadiness, type Fetcher } from "../src/index";

const GOOD = `# Acme\n\n> Acme makes widgets.\n\nSome details.\n\n## Docs\n\n- [Start](https://acme.com/start.md): begin here\n- [API](/api.md)\n\n## Optional\n\n- [Blog](/blog.md)\n`;

describe("lintLlmsTxt", () => {
  it("accepts the llmstxt.org shape", () => { const r = lintLlmsTxt(GOOD); expect(r.ok).toBe(true); expect(r.issues.filter((i) => i.severity === "error")).toEqual([]); });
  it("rejects missing H1 with a line number", () => {
    const r = lintLlmsTxt("## Docs\n- [A](/a)\n"); expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: "h1-required", line: 1 });
  });
  it("flags a malformed list item with its line", () => {
    const r = lintLlmsTxt("# A\n\n> s\n\n## Docs\n\n- not a link\n"); expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "bad-link-item")?.line).toBe(7);
  });
  it("flags a second H1 and an H3 before the first H2", () => {
    const r = lintLlmsTxt("# A\n### x\n# B\n"); expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["heading-before-h2", "multiple-h1"]));
  });
  it("ignores headings inside code fences, rejects empty file", () => {
    expect(lintLlmsTxt("# A\n\n> s\n\n```\n# not a heading\n```\n\n## D\n- [x](/x)\n").ok).toBe(true);
    expect(lintLlmsTxt("  \n").ok).toBe(false);
  });
});

describe("checkReadiness", () => {
  const site: Record<string, { status: number; headers: Record<string, string>; body: string }> = {
    "/llms.txt": { status: 200, headers: { "content-type": "text/plain" }, body: GOOD },
    "/robots.txt": { status: 200, headers: {}, body: "User-agent: *\nContent-Signal: ai-train=no\n" },
  };
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/" && /text\/markdown/.test(init?.headers?.accept ?? "")) return { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", ETag: '"x"', "Content-Signal": "ai-train=no" }, body: "# A" };
    if (path === "/") return { status: 200, headers: { "content-type": "text/html" }, body: "<html>" };
    return site[path] ?? { status: 404, headers: {}, body: "" };
  };
  it("reports every readiness item", async () => {
    const r = await checkReadiness("https://acme.com", fetcher);
    const by = Object.fromEntries(r.items.map((i) => [i.id, i.status]));
    expect(by).toMatchObject({ "llms-txt": "pass", "md-negotiation": "pass", "vary-accept": "pass", "html-unchanged": "pass", "content-signals": "pass", "llms-full": "warn", "mcp-card": "warn", "web-bot-auth": "na" });
    expect(r.passed).toBeGreaterThan(5);
  });
  it("fails negotiation on a plain site", async () => {
    const plain: Fetcher = async (u) => (new URL(u).pathname === "/" ? { status: 200, headers: { "content-type": "text/html" }, body: "" } : { status: 404, headers: {}, body: "" });
    const r = await checkReadiness("https://x.com", plain);
    expect(r.items.find((i) => i.id === "md-negotiation")?.status).toBe("fail");
  });
});
