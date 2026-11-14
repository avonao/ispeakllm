import { describe, it, expect } from "vitest";
import { createShopifyProxyHandler, verifyProxySignature } from "../src/index";
// @ts-expect-error plain JS runner
import { BUNDLE } from "../../../conformance/adapter-http/runner.mjs";

const secret = "hush-test-secret";
async function signed(path: string, params: Record<string, string>): Promise<URL> {
  const u = new URL(`https://app.example${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const msg = [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort().join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  u.searchParams.set("signature", [...mac].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return u;
}
const params = { shop: "acme.myshopify.com", path_prefix: "/apps/ispeakllm", timestamp: "1763078400" };

describe("shopify app proxy", () => {
  const handle = createShopifyProxyHandler({ secret, bundleFor: (shop) => (shop === "acme.myshopify.com" ? BUNDLE : null) });
  it("serves llms.txt and page markdown for a signed request", async () => {
    const r = await handle(new Request(await signed("/proxy/llms.txt", params)));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(BUNDLE.files["/llms.txt"].body);
    const md = await handle(new Request(await signed("/proxy/docs/quickstart.md", params)));
    expect(md.headers.get("content-signal")).toMatch(/ai-train=yes/);
  });
  it("rejects a missing or tampered signature, and unknown shops", async () => {
    expect((await handle(new Request("https://app.example/proxy/llms.txt?shop=acme.myshopify.com"))).status).toBe(401);
    const u = await signed("/proxy/llms.txt", params);
    u.searchParams.set("shop", "evil.myshopify.com");
    expect(await verifyProxySignature(u, secret)).toBe(false);
    expect((await handle(new Request(u))).status).toBe(401);
    expect((await handle(new Request(await signed("/proxy/llms.txt", { ...params, shop: "other.myshopify.com" })))).status).toBe(404);
  });
});
