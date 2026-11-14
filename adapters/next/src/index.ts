/**
 * Next.js adapter (App or Pages router, Node or Edge runtime, including OpenNext on Workers).
 *
 *   // middleware.ts
 *   import { NextResponse } from "next/server";
 *   import bundle from "./.ispeakllm/bundle.json";
 *   import { createMiddleware } from "@ispeakllm/next";
 *   export const middleware = createMiddleware(bundle, { NextResponse });
 *   export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
 *
 * Agent requests get their answer straight from the middleware. Human requests continue to
 * the app unchanged, with `Link`, `Vary: Accept` and policy headers added to the response.
 * `next` is passed in rather than imported, so this package has no dependency on it.
 */

import { createAgentHandler, discoveryHeaders, varyWithAccept, type Bundle, type ServeOptions } from "@ispeakllm/serve";

type NextResponseLike = { next(init?: { headers?: Headers }): Response & { headers: Headers } };

export type MiddlewareOptions = Omit<ServeOptions, "bundle" | "upstream"> & {
  /** `NextResponse` from `next/server`. Without it, unmatched requests return undefined (Next continues). */
  NextResponse?: NextResponseLike;
};

export function createMiddleware(bundle: Bundle | unknown, opts: MiddlewareOptions = {}) {
  const b = bundle as Bundle;
  const { NextResponse, ...serve } = opts;
  const handler = createAgentHandler({ ...serve, bundle: b });
  return async (req: Request): Promise<Response | undefined> => {
    const r = await handler.handle(req);
    if (r) return r;
    if (!NextResponse) return undefined;
    const res = NextResponse.next();
    const pathname = new URL(req.url).pathname;
    for (const [k, v] of Object.entries(discoveryHeaders(b, pathname))) {
      if (k === "vary") {
        res.headers.set("vary", varyWithAccept(res.headers.get("vary")));
      } else res.headers.set(k, v);
    }
    return res;
  };
}

/**
 * Route handler for a single file, for apps that prefer routes over middleware:
 *   // app/llms.txt/route.ts
 *   export const GET = fileRoute(bundle, "/llms.txt");
 */
export function fileRoute(bundle: Bundle | unknown, path: string) {
  const handler = createAgentHandler({ bundle: bundle as Bundle, mcpPath: false });
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    u.pathname = path;
    return (await handler.handle(new Request(u, req))) ?? new Response("Not found\n", { status: 404 });
  };
}
