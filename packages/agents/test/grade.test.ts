// New for IspeakLLM: the merged identity grade. The invariant under test is that
// `verified` comes ONLY from a completed signature check, never from a User-Agent or an address.
import { describe, expect, it } from "vitest";
import {
  attributedOperator,
  buildFetchRecord,
  createDirectoryKeyResolver,
  gradeRequest,
  type DnsResolver,
  type DirectoryFetcher,
  type SignedMessage,
} from "../src/index";
import { KEYID, NOW, PUBLIC_JWK, sign } from "./helpers";

const GPTBOT_IP = "20.171.206.10";
const record = async (msg: SignedMessage, ip: string | null, deps = {}) => {
  const identity = await gradeRequest({ message: msg, ip, now: NOW }, deps);
  const rec = await buildFetchRecord({ fetchId: "f", url: msg.url, contentSha256: "a".repeat(64), fetchedAtIso: NOW.toISOString(), identity, ip, ipSalt: "a-long-enough-secret-salt" });
  return { identity, rec };
};
const spoof = (ua: string): SignedMessage => ({ method: "GET", url: "https://site.example/llms.txt", fields: [["User-Agent", ua]] });

describe("a User-Agent or an address alone is never `verified`", () => {
  it("spoofed `User-Agent: GPTBot` is unauthenticated, claimed, and attributes to nobody", async () => {
    const { identity, rec } = await record(spoof("Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)"), "203.0.113.9");
    expect(identity.grade).toBe("unauthenticated");
    expect(identity.network).toBe("claimed");
    expect(identity.claimedAgent).toBe("gptbot");
    expect(identity.operator).toBeNull();
    expect(attributedOperator(rec)).toBeNull();
  });

  it("even a published-range IP match leaves the grade `unauthenticated`", async () => {
    const { identity, rec } = await record(spoof("GPTBot/1.1"), GPTBOT_IP, { ipRanges: async () => ["20.171.206.0/24"] });
    expect(identity.network).toBe("ip-verified");
    expect(identity.grade).toBe("unauthenticated");
    expect(attributedOperator(rec)).toBeNull();
  });

  it("even forward-confirmed reverse DNS leaves the grade `unauthenticated`", async () => {
    const dns: DnsResolver = {
      reverse: async () => ["crawl-66-249-66-1.googlebot.com."],
      forward: async () => ["66.249.66.1"],
    };
    const { identity } = await record(spoof("Googlebot/2.1"), "66.249.66.1", { dns });
    expect(identity.network).toBe("rdns-verified");
    expect(identity.grade).toBe("unauthenticated");
    expect(identity.operator).toBeNull();
  });
});

describe("network evidence", () => {
  it("claimed when the address is outside the published ranges, and says so", async () => {
    const { identity } = await record(spoof("GPTBot/1.1"), "198.51.100.7", { ipRanges: async () => ["20.171.206.0/24"] });
    expect(identity.network).toBe("claimed");
    expect(identity.networkNote).toContain("NOT inside the published ranges");
  });
  it("claimed when the range provider fails: a fault is not a finding", async () => {
    const { identity } = await record(spoof("GPTBot/1.1"), GPTBOT_IP, { ipRanges: async () => { throw new Error("boom"); } });
    expect(identity.network).toBe("claimed");
    expect(identity.networkNote).toContain("failed");
  });
  it("none when the User-Agent claims no known agent", async () => {
    const { identity } = await record(spoof("curl/8.0"), GPTBOT_IP, { ipRanges: async () => ["20.171.206.0/24"] });
    expect(identity.network).toBe("none");
    expect(identity.claimedAgent).toBeNull();
  });
  it("a PTR that does not forward-confirm is not rdns-verified", async () => {
    const dns: DnsResolver = { reverse: async () => ["crawl.googlebot.com"], forward: async () => ["10.0.0.1"] };
    const { identity } = await record(spoof("Googlebot/2.1"), "66.249.66.1", { dns });
    expect(identity.network).toBe("claimed");
  });
});

describe("signature grades through the full path", () => {
  const resolves = async () => ({ jwk: PUBLIC_JWK, source: "directory" as const });

  it("a good signature is verified, and the spoofed UA does not matter", async () => {
    const msg = await sign({ fields: [["User-Agent", "curl/8.0"]] });
    const { identity } = await record(msg, null, { resolveKey: async () => ({ jwk: PUBLIC_JWK, source: "out-of-band", operator: "Acme Crawler" }) });
    expect(identity.grade).toBe("verified");
    expect(identity.operator).toBe("Acme Crawler");
    expect(identity.keyid).toBe(KEYID);
  });

  it("a tampered signature is failed, with no operator", async () => {
    const msg = await sign();
    const tampered = { ...msg, url: "https://elsewhere.example/llms.txt" };
    const { identity, rec } = await record(tampered, null, { resolveKey: resolves });
    expect(identity.grade).toBe("failed");
    expect(identity.code).toBe("bad_signature");
    expect(attributedOperator(rec)).toBeNull();
  });

  it("an unresolvable key is unchecked", async () => {
    const { identity } = await record(await sign(), null, { resolveKey: async () => null });
    expect(identity.grade).toBe("unchecked");
    expect(identity.code).toBe("unknown_key");
  });

  it("no resolver configured is unchecked, never verified", async () => {
    const { identity } = await record(await sign(), null);
    expect(identity.grade).toBe("unchecked");
  });

  it("a verified signature from one registered operator while the UA claims another is flagged", async () => {
    const dirKey = { keys: [{ kty: "OKP", crv: "Ed25519", x: PUBLIC_JWK.x }] };
    const fetcher: DirectoryFetcher = async () => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(dirKey)), contentType: "application/json" });
    const resolveKey = createDirectoryKeyResolver({ fetcher, now: () => NOW.getTime() });
    const msg = await sign({
      components: '"@authority" "signature-agent"',
      fields: [["Signature-Agent", '"https://chatgpt.com"'], ["User-Agent", "ClaudeBot/1.0"]],
    });
    const { identity } = await record(msg, null, { resolveKey });
    expect(identity.grade).toBe("verified");
    expect(identity.operator).toBe("OpenAI");
    expect(identity.claimedAgent).toBe("claudebot");
    expect(identity.contradiction).toBe(true);
  });
});
