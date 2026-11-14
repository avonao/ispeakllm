import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { ispeakllm } from "../src/index";
// @ts-expect-error plain JS runner
import { runConformance, BUNDLE, HOST_BODY } from "../../../conformance/adapter-http/runner.mjs";

let server: Server;
let base: string;
beforeAll(async () => {
  const mw = ispeakllm(BUNDLE);
  server = createServer((req, res) =>
    mw(req, res, () => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(HOST_BODY);
    }),
  );
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("express adapter", () => {
  it("passes the full adapter conformance suite over real HTTP", async () => {
    const rep = await runConformance((req: Request) => fetch(req), { base, level: "full" });
    expect(rep.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });
});
