import { describe, it, expect } from "vitest";
import { ispeakllm } from "../src/index";
// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, HOST_BODY } from "../../../conformance/adapter-http/runner.mjs";

// Minimal Hono-shaped app: one middleware, then a host handler.
function app(mw: ReturnType<typeof ispeakllm>) {
  return async (req: Request): Promise<Response> => {
    const c = { req: { raw: req }, res: new Response(null) };
    const early = await mw(c, async () => {
      c.res = new Response(HOST_BODY, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    return early ?? c.res;
  };
}

describe("hono adapter", () => {
  it("passes the full adapter conformance suite", async () => {
    const rep = await runConformance(app(ispeakllm(BUNDLE)), { level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
});
