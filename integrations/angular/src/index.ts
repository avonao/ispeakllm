// Ported from integrations/angular/src/lib/llmstxt.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * Angular SSR runs on an Express server (`server.ts`). Mount the middleware before the Angular engine:
 *
 *   import bundle from "../.ispeakllm/bundle.json";
 *   import { ispeakllmForAngular } from "@ispeakllm/angular";
 *   server.use(ispeakllmForAngular(bundle));
 *   server.get("**", (req, res, next) => angularApp.handle(req).then(...));
 *
 * For the browser side, add the discovery links in a component:
 *   inject(Meta) is for <meta>; for <link> use the DOCUMENT: addMarkdownLinks(inject(DOCUMENT), router.url)
 */

import { ispeakllm, type ExpressOptions } from "@ispeakllm/express";
import type { Bundle } from "@ispeakllm/serve";

export function ispeakllmForAngular(bundle: Bundle | unknown, opts: ExpressOptions = {}) {
  return ispeakllm(bundle, opts);
}

type DocLike = { head: { querySelector(s: string): unknown; appendChild(n: unknown): unknown }; createElement(t: string): { setAttribute(k: string, v: string): void } };

/** Add `<link rel="alternate" type="text/markdown">` and `rel="describedby"` once (idempotent). */
export function addMarkdownLinks(doc: DocLike, url: string): void {
  const path = (url.split(/[?#]/)[0] ?? "/").replace(/\/+$/, "") || "/";
  const links: [string, string][] = [
    ["alternate", path === "/" ? "/index.md" : `${path}.md`],
    ["describedby", "/llms.txt"],
  ];
  for (const [rel, href] of links) {
    if (doc.head.querySelector(`link[rel="${rel}"][type="text/markdown"]`)) continue;
    const el = doc.createElement("link");
    el.setAttribute("rel", rel);
    el.setAttribute("type", "text/markdown");
    el.setAttribute("href", href);
    doc.head.appendChild(el);
  }
}
