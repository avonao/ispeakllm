// Ported from integrations/vue/src/llmstxt.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * Nuxt / Nitro server middleware (h3), plus a head helper for any Vue app.
 *
 *   // server/middleware/ispeakllm.ts
 *   import { defineEventHandler, toWebRequest } from "h3";
 *   import bundle from "~/.ispeakllm/bundle.json";
 *   import { createNitroMiddleware } from "@ispeakllm/nuxt";
 *   export default defineEventHandler(createNitroMiddleware(bundle, { toWebRequest }));
 *
 * Agent requests are answered by returning a web Response (h3 sends it). Other requests fall
 * through (undefined) after discovery and policy headers are set on the outgoing response.
 *
 *   // any component: useHead({ link: markdownAlternateLinks(route.path) })
 */

import { createAgentHandler, discoveryHeaders, type Bundle, type ServeOptions } from "@ispeakllm/serve";

type H3EventLike = { node: { res: { setHeader(k: string, v: string): void; getHeader(k: string): unknown } } };

export type NitroOptions = Omit<ServeOptions, "bundle" | "upstream"> & {
  /** `toWebRequest` from h3 (passed in so this package does not depend on h3). */
  toWebRequest: (event: never) => Request;
};

export function createNitroMiddleware(bundle: Bundle | unknown, opts: NitroOptions) {
  const b = bundle as Bundle;
  const { toWebRequest, ...serve } = opts;
  const handler = createAgentHandler({ ...serve, bundle: b });
  return async (event: H3EventLike): Promise<Response | undefined> => {
    const req = toWebRequest(event as never);
    const r = await handler.handle(req);
    if (r) return r;
    const res = event.node.res;
    for (const [k, v] of Object.entries(discoveryHeaders(b, new URL(req.url).pathname))) {
      if (k === "vary") {
        const cur = res.getHeader("vary")?.toString();
        if (!cur || !/\baccept\b/i.test(cur)) res.setHeader("vary", cur ? `${cur}, Accept` : "Accept");
      } else res.setHeader(k, v);
    }
    return undefined;
  };
}

/** `<link>` entries for `useHead` / `@unhead/vue`: the page's Markdown and the site's llms.txt. */
export function markdownAlternateLinks(pathname: string): { rel: string; type: string; href: string }[] {
  const p = pathname.replace(/\/+$/, "") || "/";
  return [
    { rel: "alternate", type: "text/markdown", href: p === "/" ? "/index.md" : `${p}.md` },
    { rel: "describedby", type: "text/markdown", href: "/llms.txt" },
  ];
}
