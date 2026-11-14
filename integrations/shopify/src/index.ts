// Ported from integrations/shopify/web/src/proxy/llmstxt.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * Shopify storefronts are served by Shopify, so files cannot be dropped at the shop's root.
 * An App Proxy forwards `https://{shop}/apps/{subpath}/...` to your app backend. This handler
 * verifies the proxy signature, picks the shop's bundle and answers with the same behaviour as
 * every other IspeakLLM adapter (llms.txt, page Markdown, ACM, policy files).
 *
 *   const handle = createShopifyProxyHandler({ secret: env.SHOPIFY_API_SECRET, bundleFor: (shop) => loadBundle(shop) });
 *   // in your app: route /proxy/* -> handle(request)
 *
 * Point the theme at the proxy (e.g. a URL redirect from /llms.txt to /apps/ispeakllm/llms.txt).
 */

import { createAgentHandler, type Bundle } from "@ispeakllm/serve";

export type ShopifyProxyOptions = {
  /** The app's API secret key (shared secret). Requests without a valid signature get 401. */
  secret: string;
  /** Return the bundle for a shop (`acme.myshopify.com`), or null when the shop has none. */
  bundleFor: (shop: string) => Promise<Bundle | null> | Bundle | null;
  /** Path prefix your backend receives for proxied requests (default `/proxy`). */
  prefix?: string;
};

const enc = new TextEncoder();

/** Shopify App Proxy signature: HMAC-SHA256(secret, sorted `k=v` pairs joined with no separator), hex. */
export async function verifyProxySignature(url: URL, secret: string): Promise<boolean> {
  const sig = url.searchParams.get("signature");
  if (!sig || !secret) return false;
  const grouped = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) if (k !== "signature") grouped.set(k, [...(grouped.get(k) ?? []), v]);
  const message = [...grouped.entries()].map(([k, vs]) => `${k}=${vs.join(",")}`).sort().join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function createShopifyProxyHandler(opts: ShopifyProxyOptions) {
  const prefix = (opts.prefix ?? "/proxy").replace(/\/+$/, "");
  const handlers = new Map<Bundle, ReturnType<typeof createAgentHandler>>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!(await verifyProxySignature(url, opts.secret))) return new Response("Invalid proxy signature\n", { status: 401 });
    const shop = url.searchParams.get("shop") ?? "";
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return new Response("Unknown shop\n", { status: 400 });
    const bundle = await opts.bundleFor(shop);
    if (!bundle) return new Response("Not found\n", { status: 404 });
    let h = handlers.get(bundle);
    if (!h) handlers.set(bundle, (h = createAgentHandler({ bundle, mcpPath: false })));
    // Strip the proxy prefix and the query (Shopify's signing params) before the shared handler sees it.
    const inner = new URL((url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname) || "/", `https://${shop}`);
    const res = await h.handle(new Request(inner, { method: req.method, headers: req.headers }));
    return res ?? new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  };
}
