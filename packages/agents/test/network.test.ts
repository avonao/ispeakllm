// New for iSpeakLLM: CIDR matching, forward-confirmed rDNS, registry, salted IP hash.
import { describe, expect, it } from "vitest";
import {
  KNOWN_AGENTS,
  agentBySignatureOrigin,
  createDohResolver,
  forwardConfirmedReverse,
  ipInAnyCidr,
  matchAgentByUserAgent,
  normaliseIp,
  parseCidr,
  parseIp,
  saltedIpHash,
  toArpaName,
  type DnsResolver,
} from "../src/index";

describe("CIDR", () => {
  it("matches IPv4 ranges at the boundaries", () => {
    expect(ipInAnyCidr("192.0.2.0", ["192.0.2.0/24"])).toBe(true);
    expect(ipInAnyCidr("192.0.2.255", ["192.0.2.0/24"])).toBe(true);
    expect(ipInAnyCidr("192.0.3.0", ["192.0.2.0/24"])).toBe(false);
    expect(ipInAnyCidr("10.1.2.3", ["10.0.0.0/8", "172.16.0.0/12"])).toBe(true);
    expect(ipInAnyCidr("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
    expect(ipInAnyCidr("1.2.3.4", ["1.2.3.4/32"])).toBe(true);
    expect(ipInAnyCidr("1.2.3.5", ["1.2.3.4"])).toBe(false);
  });
  it("matches IPv6 ranges and never mixes families", () => {
    expect(ipInAnyCidr("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipInAnyCidr("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipInAnyCidr("2001:DB8:0:0:0:0:0:1", ["2001:db8::/32"])).toBe(true);
    expect(ipInAnyCidr("2001:db8::1", ["192.0.2.0/24"])).toBe(false);
    expect(ipInAnyCidr("192.0.2.1", ["2001:db8::/32"])).toBe(false);
    expect(ipInAnyCidr("::1", ["::1/128"])).toBe(true);
  });
  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipInAnyCidr("::ffff:192.0.2.7", ["192.0.2.0/24"])).toBe(true);
    expect(parseIp("::ffff:c000:207")).toEqual(parseIp("192.0.2.7"));
  });
  it("rejects malformed addresses and ranges rather than guessing", () => {
    for (const bad of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "", "gggg::1", "1::2::3", "1:2:3:4:5:6:7:8:9"]) expect(parseIp(bad)).toBeNull();
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("1.2.3.4/x")).toBeNull();
    expect(parseCidr("::/129")).toBeNull();
    expect(ipInAnyCidr("not-an-ip", ["0.0.0.0/0"])).toBe(false);
    expect(ipInAnyCidr("1.2.3.4", ["junk", "1.2.3.0/24"])).toBe(true);
  });
  it("builds reverse-lookup names", () => {
    expect(toArpaName("192.0.2.1")).toBe("1.2.0.192.in-addr.arpa");
    expect(toArpaName("2001:db8::1")).toBe("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa");
    expect(toArpaName("nope")).toBeNull();
    expect(normaliseIp("2001:db8::1")).toBe("20010db8000000000000000000000001");
  });
});

describe("forward-confirmed reverse DNS", () => {
  const dns = (ptr: string[] | Error, fwd: string[] | Error): DnsResolver => ({
    reverse: async () => { if (ptr instanceof Error) throw ptr; return ptr; },
    forward: async () => { if (fwd instanceof Error) throw fwd; return fwd; },
  });
  const G = ["googlebot.com", "google.com"];

  it("confirms only the full round trip under an accepted suffix", async () => {
    const r = await forwardConfirmedReverse("66.249.66.1", G, dns(["crawl-66-249-66-1.googlebot.com."], ["66.249.66.1"]));
    expect(r).toMatchObject({ ran: true, forwardConfirmed: true, hostname: "crawl-66-249-66-1.googlebot.com" });
  });
  it("a PTR outside the suffix is not confirmed (suffix match is on label boundaries)", async () => {
    expect((await forwardConfirmedReverse("66.249.66.1", G, dns(["evilgooglebot.com"], ["66.249.66.1"]))).forwardConfirmed).toBe(false);
    expect((await forwardConfirmedReverse("66.249.66.1", G, dns(["host.example.net"], ["66.249.66.1"]))).forwardConfirmed).toBe(false);
  });
  it("a PTR whose forward records point elsewhere is not confirmed", async () => {
    const r = await forwardConfirmedReverse("66.249.66.1", G, dns(["a.googlebot.com"], ["10.0.0.1"]));
    expect(r.forwardConfirmed).toBe(false);
    expect(r.note).toContain("NOT confirmed");
  });
  it("lookup faults are distinct from findings", async () => {
    const a = await forwardConfirmedReverse("66.249.66.1", G, dns(new Error("timeout"), []));
    expect(a.note).toContain("lookup fault");
    const b = await forwardConfirmedReverse("66.249.66.1", G, dns(["a.googlebot.com"], new Error("timeout")));
    expect(b.note).toContain("failed or timed out");
    const c = await forwardConfirmedReverse("66.249.66.1", G, dns([], []));
    expect(c.note).toContain("no PTR");
    const d = await forwardConfirmedReverse(null, G, dns([], []));
    expect(d.ran).toBe(false);
    const e = await forwardConfirmedReverse("garbage", G, dns([], []));
    expect(e.ran).toBe(false);
  });
  it("works for IPv6 across formatting differences", async () => {
    const r = await forwardConfirmedReverse("2001:4860:4801:10::1", G, dns(["crawl.googlebot.com"], ["2001:4860:4801:0010:0:0:0:1"]));
    expect(r.forwardConfirmed).toBe(true);
  });
  it("the DoH adapter builds PTR/A/AAAA queries over the injected fetch and treats NXDOMAIN as an empty answer", async () => {
    const urls: string[] = [];
    const doh = createDohResolver({
      endpoint: "https://dns.example/dns-query",
      fetch: async (url) => {
        urls.push(url);
        const type = new URL(url).searchParams.get("type");
        const body = type === "PTR" ? { Status: 0, Answer: [{ type: 12, data: "a.googlebot.com." }] } : type === "A" ? { Status: 0, Answer: [{ type: 1, data: "66.249.66.1" }] } : { Status: 3 };
        return { ok: true, json: async () => body };
      },
    });
    const r = await forwardConfirmedReverse("66.249.66.1", G, doh);
    expect(r.forwardConfirmed).toBe(true);
    expect(urls[0]).toContain("name=1.66.249.66.in-addr.arpa&type=PTR");
    const failing = createDohResolver({ endpoint: "https://dns.example/q", fetch: async () => ({ ok: false, json: async () => ({}) }) });
    await expect(failing.reverse("66.249.66.1")).rejects.toThrow();
  });
});

describe("known-agent registry", () => {
  it("contains the required agents", () => {
    const tokens = KNOWN_AGENTS.map((a) => a.token).sort();
    expect(tokens).toEqual(
      ["Applebot", "Bingbot", "Bytespider", "CCBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "ClaudeBot", "GPTBot", "Google-Extended", "Googlebot", "OAI-SearchBot", "Perplexity-User", "PerplexityBot"].sort(),
    );
  });
  it("reads a UA as a CLAIM, longest token first, case-insensitively", () => {
    expect(matchAgentByUserAgent("Mozilla/5.0 (compatible; GPTBot/1.1)")?.id).toBe("gptbot");
    expect(matchAgentByUserAgent("claude-searchbot/1.0")?.id).toBe("claude-searchbot");
    expect(matchAgentByUserAgent("Perplexity-User/1.0")?.id).toBe("perplexity-user");
    expect(matchAgentByUserAgent("curl/8")).toBeNull();
    expect(matchAgentByUserAgent(null)).toBeNull();
  });
  it("only registered origins map to an operator", () => {
    expect(agentBySignatureOrigin("https://chatgpt.com")?.operator).toBe("OpenAI");
    expect(agentBySignatureOrigin("https://attacker.example")).toBeNull();
  });
  it("every https signing origin and range URL is https", () => {
    for (const a of KNOWN_AGENTS) {
      for (const o of a.signatureAgentOrigins ?? []) expect(o.startsWith("https://")).toBe(true);
      if (a.ipRangesUrl) expect(a.ipRangesUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("salted IP hash", () => {
  const salt = "a-long-enough-secret-salt";
  it("is deterministic per salt, differs by salt and by address, and never contains the address", async () => {
    const a = await saltedIpHash("203.0.113.9", salt);
    expect(a).toMatch(/^ip1_[0-9a-f]{32}$/);
    expect(await saltedIpHash("203.0.113.9", salt)).toBe(a);
    expect(await saltedIpHash("203.0.113.10", salt)).not.toBe(a);
    expect(await saltedIpHash("203.0.113.9", "another-long-enough-salt")).not.toBe(a);
    expect(a).not.toContain("203");
  });
  it("hashes equivalent spellings of one address identically", async () => {
    expect(await saltedIpHash("2001:db8::1", salt)).toBe(await saltedIpHash("2001:0DB8:0:0:0:0:0:1", salt));
    expect(await saltedIpHash("::ffff:203.0.113.9", salt)).toBe(await saltedIpHash("203.0.113.9", salt));
  });
  it("stores nothing for an unusable address and refuses a weak salt", async () => {
    expect(await saltedIpHash("not an ip", salt)).toBeNull();
    expect(await saltedIpHash(null, salt)).toBeNull();
    await expect(saltedIpHash("1.2.3.4", "short")).rejects.toThrow(RangeError);
  });
});
