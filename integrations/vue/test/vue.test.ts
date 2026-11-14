import { describe, it, expect } from "vitest";
import { createNitroMiddleware, markdownAlternateLinks } from "../src/index";
// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, hostResponse } from "../../../conformance/adapter-http/runner.mjs";

// h3-shaped harness: the middleware runs, then the "app" renders, carrying headers the middleware set.
function app() {
  const mw = createNitroMiddleware(BUNDLE, { toWebRequest: (e: never) => (e as unknown as { req: Request }).req });
  return async (req: Request): Promise<Response> => {
    const set = new Map<string, string>();
    const event = { req, node: { res: { setHeader: (k: string, v: string) => void set.set(k, v), getHeader: (k: string) => set.get(k) } } };
    const r = await mw(event as never);
    if (r) return r;
    const host = hostResponse(new URL(req.url).pathname);
    const h = new Headers(host.headers);
    for (const [k, v] of set) h.set(k, v);
    return new Response(host.body, { status: host.status, headers: h });
  };
}

describe("nuxt / nitro middleware", () => {
  it("passes the full adapter conformance suite", async () => {
    const rep = await runConformance(app(), { level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
  it("head links", () => {
    expect(markdownAlternateLinks("/docs/")[0]!.href).toBe("/docs.md");
    expect(markdownAlternateLinks("/")[0]!.href).toBe("/index.md");
  });
});
