// New for iSpeakLLM: Signature-Agent directory discovery bounds.
import { describe, expect, it } from "vitest";
import {
  KeyResolutionError,
  createDirectoryKeyResolver,
  ed25519Thumbprint,
  verifyWebBotAuth,
  type DirectoryFetcher,
  type DirectoryFetchResult,
} from "../src/index";
import { KEYID, NOW, PUBLIC_JWK, sign } from "./helpers";

const ORIGIN = "https://chatgpt.com";
const DIR = { keys: [{ kty: "OKP", crv: "Ed25519", x: PUBLIC_JWK.x, kid: "decorated" }, { kty: "RSA", n: "x", e: "AQAB" }] };
const ok = (body: unknown = DIR): DirectoryFetchResult => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(body)), contentType: "application/json" });

function harness(responder: (url: string) => DirectoryFetchResult | Promise<DirectoryFetchResult> = () => ok(), over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let t = NOW.getTime();
  const fetcher: DirectoryFetcher = async (url) => {
    calls.push(url);
    return responder(url);
  };
  const resolveKey = createDirectoryKeyResolver({ fetcher, now: () => t, ...over });
  return { calls, resolveKey, advance: (s: number) => { t += s * 1000; } };
}

const signedWithAgent = (agent = '"https://chatgpt.com"') =>
  sign({ components: '"@authority" "signature-agent"', fields: [["Signature-Agent", agent]] });

describe("discovery bounds", () => {
  it("fetches /.well-known/http-message-signatures-directory once and verifies", async () => {
    const h = harness();
    const v = await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: h.resolveKey });
    expect(v.grade).toBe("verified");
    expect(v.operator).toBe("OpenAI");
    expect(h.calls).toEqual(["https://chatgpt.com/.well-known/http-message-signatures-directory"]);
  });

  it("an UNCOVERED Signature-Agent never triggers a fetch", async () => {
    const h = harness();
    const msg = await sign({ fields: [["Signature-Agent", '"https://chatgpt.com"']] });
    const v = await verifyWebBotAuth(msg, { now: NOW, resolveKey: h.resolveKey });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("unknown_key");
    expect(h.calls).toEqual([]);
  });

  it("an origin that is not allowlisted is unchecked and never fetched", async () => {
    const h = harness();
    const v = await verifyWebBotAuth(await signedWithAgent('"https://attacker.example"'), { now: NOW, resolveKey: h.resolveKey });
    expect(v).toMatchObject({ grade: "unchecked", code: "directory_origin_not_allowed" });
    expect(h.calls).toEqual([]);
  });

  it("a configured allowlist replaces the default", async () => {
    const h = harness(() => ok(), { allowedOrigins: ["https://bot.example"] });
    const v = await verifyWebBotAuth(await signedWithAgent('"https://chatgpt.com"'), { now: NOW, resolveKey: h.resolveKey });
    expect(v.code).toBe("directory_origin_not_allowed");
    const v2 = await verifyWebBotAuth(await signedWithAgent('"https://bot.example"'), { now: NOW, resolveKey: h.resolveKey });
    expect(v2.grade).toBe("verified");
    expect(v2.operator).toBe("bot.example");
  });

  it("plaintext http is never fetched", async () => {
    const h = harness(() => ok(), { allowedOrigins: () => true });
    const v = await verifyWebBotAuth(await signedWithAgent('"http://chatgpt.com"'), { now: NOW, resolveKey: h.resolveKey });
    expect(v.grade).toBe("unchecked");
    expect(h.calls).toEqual([]);
  });

  it("refuses a redirect", async () => {
    const h = harness(() => ({ status: 302, body: new Uint8Array(), redirected: true }));
    const v = await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: h.resolveKey });
    expect(v).toMatchObject({ grade: "unchecked", code: "directory_redirect_refused" });
  });

  it("refuses an oversized or truncated body", async () => {
    const big = harness(() => ({ status: 200, body: new Uint8Array(70_000), contentType: "application/json" }));
    expect((await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: big.resolveKey })).code).toBe("directory_too_large");
    const cut = harness(() => ({ ...ok(), truncated: true }));
    expect((await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: cut.resolveKey })).code).toBe("directory_too_large");
  });

  it("a bad status, bad content type, malformed JSON or a fetch failure is unchecked, never failed", async () => {
    const cases: Array<[() => DirectoryFetchResult | Promise<DirectoryFetchResult>, string]> = [
      [() => ({ status: 404, body: new Uint8Array() }), "directory_bad_status"],
      [() => ({ ...ok(), contentType: "text/html" }), "directory_bad_content_type"],
      [() => ({ status: 200, body: new TextEncoder().encode("{nope"), contentType: "application/json" }), "directory_malformed"],
      [() => ok({ nokeys: true }), "directory_malformed"],
      [() => Promise.reject(new Error("timeout")), "directory_unreachable"],
    ];
    for (const [responder, code] of cases) {
      const v = await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: harness(responder).resolveKey });
      expect(v).toMatchObject({ grade: "unchecked", code });
    }
  });

  it("a directory serving a key under the wrong id is unchecked: the keyid must be the thumbprint", async () => {
    const msg = await sign({ components: '"@authority" "signature-agent"', fields: [["Signature-Agent", '"https://chatgpt.com"']], keyid: "not-the-thumbprint" });
    const v = await verifyWebBotAuth(msg, { now: NOW, resolveKey: harness().resolveKey });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("unknown_key");
  });

  it("the thumbprint of the served key is what is matched", async () => {
    expect(await ed25519Thumbprint(PUBLIC_JWK)).toBe(KEYID);
  });
});

describe("refetch floor and cache", () => {
  it("serves repeat requests from the cache", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await verifyWebBotAuth(await signedWithAgent(), { now: NOW, resolveKey: h.resolveKey });
    expect(h.calls).toHaveLength(1);
  });

  it("a flood of unknown keyids cannot make us refetch inside the floor", async () => {
    const h = harness();
    await h.resolveKey(KEYID, ORIGIN);
    for (let i = 0; i < 20; i++) expect(await h.resolveKey(`unknown-${i}`, ORIGIN)).toBeNull();
    expect(h.calls).toHaveLength(1);
    h.advance(61);
    expect(await h.resolveKey("unknown-after", ORIGIN)).toBeNull();
    expect(h.calls).toHaveLength(2);
  });

  it("a failed fetch is remembered for the floor, then retried", async () => {
    let fail = true;
    const h = harness(() => (fail ? { status: 500, body: new Uint8Array() } : ok()));
    await expect(h.resolveKey(KEYID, ORIGIN)).rejects.toBeInstanceOf(KeyResolutionError);
    await expect(h.resolveKey(KEYID, ORIGIN)).rejects.toMatchObject({ code: "directory_bad_status" });
    expect(h.calls).toHaveLength(1);
    fail = false;
    h.advance(61);
    expect((await h.resolveKey(KEYID, ORIGIN))?.source).toBe("directory");
    expect(h.calls).toHaveLength(2);
  });

  it("refreshes after the ttl", async () => {
    const h = harness();
    await h.resolveKey(KEYID, ORIGIN);
    h.advance(3601);
    await h.resolveKey(KEYID, ORIGIN);
    expect(h.calls).toHaveLength(2);
  });

  it("caps the number of keys read", async () => {
    const many = { keys: Array.from({ length: 50 }, () => ({ kty: "OKP", crv: "Ed25519", x: PUBLIC_JWK.x })) };
    const h = harness(() => ok(many), { maxKeys: 2 });
    expect((await h.resolveKey(KEYID, ORIGIN))?.jwk).toBeTruthy();
  });

  it("out-of-band keys win and need no fetch", async () => {
    const h = harness(() => { throw new Error("must not fetch"); }, { outOfBandKeys: { "my-key": { jwk: PUBLIC_JWK, operator: "Acme" } } });
    expect(await h.resolveKey("my-key", null)).toMatchObject({ source: "out-of-band", operator: "Acme" });
    expect(h.calls).toEqual([]);
  });
});

