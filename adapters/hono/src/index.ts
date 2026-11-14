/**
 * Hono middleware (structurally typed, so this package does not depend on hono).
 *
 *   import { ispeakllm } from "@ispeakllm/hono";
 *   app.use("*", ispeakllm(bundle));
 */

import { createAgentHandler, decorateHtml, type Bundle, type ServeOptions } from "@ispeakllm/serve";

type HonoContextLike = { req: { raw: Request }; res: Response };

export function ispeakllm(bundle: Bundle | unknown, opts: Omit<ServeOptions, "bundle" | "upstream"> = {}) {
  const b = bundle as Bundle;
  const handler = createAgentHandler({ ...opts, bundle: b });
  return async (c: HonoContextLike, next: () => Promise<void>): Promise<Response | void> => {
    const r = await handler.handle(c.req.raw);
    if (r) return r;
    await next();
    c.res = await decorateHtml(b, c.req.raw, c.res);
  };
}
