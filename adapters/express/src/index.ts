/**
 * Express / Connect / plain node:http middleware.
 *
 *   import bundle from "./.ispeakllm/bundle.json" with { type: "json" };
 *   import { ispeakllm } from "@ispeakllm/express";
 *   app.use(ispeakllm(bundle));
 *
 * Agent requests are answered here. Other requests continue to `next()`, and discovery and policy
 * headers are set on the response before your handler writes it. Mount it before body parsers
 * if you use the MCP endpoint (it reads the raw JSON body itself).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createAgentHandler, discoveryHeaders, varyWithAccept, type Bundle, type ServeOptions } from "@ispeakllm/serve";

export type ExpressOptions = Omit<ServeOptions, "bundle" | "upstream"> & {
  /** Public origin used to build absolute request URLs (default: from the Host header, http unless `x-forwarded-proto`). */
  origin?: string;
};

type Next = (err?: unknown) => void;

function toRequest(req: IncomingMessage, origin?: string): Request {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "http";
  const base = origin ?? `${proto}://${req.headers.host ?? "localhost"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = new ReadableStream({
      start(ctrl) {
        req.on("data", (c: Buffer) => ctrl.enqueue(new Uint8Array(c)));
        req.on("end", () => ctrl.close());
        req.on("error", (e) => ctrl.error(e));
      },
    });
    init.duplex = "half";
  }
  return new Request(new URL((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/", base), init);
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

export function ispeakllm(bundle: Bundle | unknown, opts: ExpressOptions = {}) {
  const b = bundle as Bundle;
  const { origin, ...serve } = opts;
  const handler = createAgentHandler({ ...serve, bundle: b });
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const request = toRequest(req, origin);
    handler
      .handle(request)
      .then(async (r) => {
        if (r) return send(res, r);
        for (const [k, v] of Object.entries(discoveryHeaders(b, new URL(request.url).pathname))) {
          if (k === "vary") {
            const cur = res.getHeader("vary");
            res.setHeader("vary", varyWithAccept(Array.isArray(cur) ? cur.join(", ") : cur?.toString()));
          } else res.setHeader(k, v);
        }
        next();
      })
      .catch(next);
  };
}
