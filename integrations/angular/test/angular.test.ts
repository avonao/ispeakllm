import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { ispeakllmForAngular, addMarkdownLinks } from "../src/index";
// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, hostResponse } from "../../../conformance/adapter-http/runner.mjs";

let server: Server;
let base: string;
beforeAll(async () => {
  const mw = ispeakllmForAngular(BUNDLE);
  server = createServer((req, res) =>
    mw(req, res, async () => {
      const host = hostResponse(new URL(req.url ?? "/", "http://x").pathname);
      res.statusCode = host.status;
      res.setHeader("content-type", host.headers.get("content-type")!);
      res.end(await host.text());
    }),
  );
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("angular ssr", () => {
  it("passes the full adapter conformance suite over HTTP", async () => {
    const rep = await runConformance((req: Request) => fetch(req), { base, level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
  it("adds head links once", () => {
    const added: Record<string, string>[] = [];
    const doc = {
      head: { querySelector: (s: string) => (added.some((a) => s.includes(`rel="${a.rel}"`)) ? {} : null), appendChild: (n: unknown) => void added.push((n as { attrs: Record<string, string> }).attrs) },
      createElement: () => { const attrs: Record<string, string> = {}; return { attrs, setAttribute: (k: string, v: string) => void (attrs[k] = v) }; },
    };
    addMarkdownLinks(doc, "/docs/quickstart?x=1");
    addMarkdownLinks(doc, "/docs/quickstart");
    expect(added.map((a) => a.href)).toEqual(["/docs/quickstart.md", "/llms.txt"]);
  });
});
