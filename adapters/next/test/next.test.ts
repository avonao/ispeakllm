import { describe, it, expect } from "vitest";
import { makeBundle } from "@ispeakllm/serve";
import { createMiddleware, fileRoute } from "../src/index";

const bundle = await makeBundle({
  files: [
    { path: "/llms.txt", content: "# Acme\n", contentType: "text/markdown; charset=utf-8" },
    { path: "/docs.md", content: "# Docs\n\nRead me.\n", contentType: "text/markdown; charset=utf-8" },
  ],
  corpus: { siteName: "Acme", pages: [] },
  generatedAt: "2026-11-14T00:00:00Z",
});
const NextResponse = { next: () => new Response(null, { headers: { "x-middleware-next": "1" } }) as Response & { headers: Headers } };

describe("next adapter", () => {
  it("answers agents and lets humans through with discovery headers", async () => {
    const mw = createMiddleware(bundle, { NextResponse });
    const md = (await mw(new Request("https://x/docs", { headers: { accept: "text/markdown" } })))!;
    expect(await md.text()).toContain("Read me.");
    const human = (await mw(new Request("https://x/docs")))!;
    expect(human.headers.get("x-middleware-next")).toBe("1");
    expect(human.headers.get("link")).toMatch(/docs\.md/);
    expect(human.headers.get("vary")).toBe("Accept");
    expect(await createMiddleware(bundle)(new Request("https://x/about"))).toBeUndefined();
  });
  it("fileRoute serves one file", async () => {
    const r = await fileRoute(bundle, "/llms.txt")(new Request("https://x/llms.txt"));
    expect(await r.text()).toBe("# Acme\n");
  });
});

// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, HOST_BODY } from "../../../conformance/adapter-http/runner.mjs";
describe("next conformance", () => {
  it("passes the full adapter conformance suite", async () => {
    // NextResponse.next() continues to the app; emulate the app answering with the host page.
    const mw = createMiddleware(BUNDLE, { NextResponse: { next: () => new Response(HOST_BODY, { headers: { "content-type": "text/html; charset=utf-8" } }) as Response & { headers: Headers } } });
    const rep = await runConformance(async (req: Request) => (await mw(req))!, { level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
});
