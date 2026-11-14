// Ported from integrations/svelte/src/lib/server/llmstxt.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * SvelteKit server hook.
 *
 *   // src/hooks.server.ts
 *   import bundle from "../.ispeakllm/bundle.json";
 *   import { ispeakllmHandle } from "@ispeakllm/sveltekit";
 *   export const handle = ispeakllmHandle(bundle);
 *   // with other hooks: export const handle = sequence(ispeakllmHandle(bundle), yourHandle);
 */

import { createAgentHandler, decorateHtml, type Bundle, type ServeOptions } from "@ispeakllm/serve";

type HandleInput = { event: { request: Request }; resolve: (event: never) => Promise<Response> | Response };

export function ispeakllmHandle(bundle: Bundle | unknown, opts: Omit<ServeOptions, "bundle" | "upstream"> = {}) {
  const b = bundle as Bundle;
  const handler = createAgentHandler({ ...opts, bundle: b });
  return async ({ event, resolve }: HandleInput): Promise<Response> => {
    const r = await handler.handle(event.request);
    if (r) return r;
    return decorateHtml(b, event.request, await resolve(event as never));
  };
}
