import { describe, it, expect } from "vitest";
import { ispeakllmHandle } from "../src/index";
// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, hostResponse } from "../../../conformance/adapter-http/runner.mjs";

describe("sveltekit handle", () => {
  it("passes the full adapter conformance suite", async () => {
    const handle = ispeakllmHandle(BUNDLE);
    const rep = await runConformance((request: Request) => handle({ event: { request }, resolve: async () => hostResponse(new URL(request.url).pathname) }), { level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
});
