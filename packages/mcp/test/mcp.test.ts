import { describe, it, expect } from "vitest";
import { createMcpHandler, handleRpc, searchPages, type McpCorpus } from "../src/index";

const corpus: McpCorpus = {
  siteName: "Acme",
  pages: [
    { path: "/", title: "Home", md: "# Home\nWelcome to Acme widgets." },
    { path: "/pricing", title: "Pricing", md: "# Pricing\nWidgets cost 5 euros per month. Widgets are great." },
  ],
  policy: { "content-signal": "ai-train=no" },
};
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", id, method, params });
const call = (name: string, args: unknown) => handleRpc(corpus, rpc("tools/call", { name, arguments: args })) as any;

describe("mcp", () => {
  it("initialize + tools/list", () => {
    expect((handleRpc(corpus, rpc("initialize")) as any).result.capabilities.tools).toBeTruthy();
    expect((handleRpc(corpus, rpc("tools/list")) as any).result.tools.map((t: any) => t.name)).toEqual(["search", "get_page", "get_policy", "get_manifest"]);
  });
  it("search ranks title/body matches and get_page returns published markdown", () => {
    const s = JSON.parse(call("search", { query: "pricing widgets" }).result.content[0].text);
    expect(s[0].path).toBe("/pricing");
    expect(call("get_page", { path: "/pricing.md" }).result.content[0].text).toContain("5 euros");
  });
  it("never invents: unknown page and unmatched query are explicit", () => {
    const r = call("get_page", { path: "/secret" }).result;
    expect(r.isError).toBe(true);
    expect(call("search", { query: "zebra" }).result.content[0].text).toMatch(/No published page/);
    expect(searchPages(corpus, "zebra")).toEqual([]);
  });
  it("policy and manifest tools", () => {
    expect(call("get_policy", { name: "content-signal" }).result.content[0].text).toBe("ai-train=no");
    expect(call("get_manifest", {}).result.isError).toBe(true);
  });
  it("errors: unknown method, notification, bad request", () => {
    expect((handleRpc(corpus, rpc("nope")) as any).error.code).toBe(-32601);
    expect(handleRpc(corpus, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect((handleRpc(corpus, { id: 1 } as any) as any).error.code).toBe(-32600);
  });
  it("HTTP handler: POST works, GET is 405, bad JSON is 400", async () => {
    const h = createMcpHandler(corpus);
    const r = await h(new Request("https://x/mcp", { method: "POST", body: JSON.stringify(rpc("ping")) }));
    expect(await r.json()).toMatchObject({ result: {} });
    expect((await h(new Request("https://x/mcp"))).status).toBe(405);
    expect((await h(new Request("https://x/mcp", { method: "POST", body: "{" }))).status).toBe(400);
  });
});
