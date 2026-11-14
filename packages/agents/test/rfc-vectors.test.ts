// RFC 9421 Appendix B.2.5 and B.2.6, RFC 8037 Appendix A.3 (ported from the Consentrack suite's anchoring approach:
// canonicalisation is checked against signatures made by key material this repo does not control).
//
// B.2.5 is HMAC-SHA256: this package implements ed25519 only, so for B.2.5 the
// vector anchors the SIGNATURE BASE (the part this package owns): the RFC's
// published base string must be reproduced byte for byte, and the RFC's
// published signature must be the HMAC of exactly that base.
import { describe, expect, it } from "vitest";
import {
  base64FromBytes,
  bytesFromBase64,
  ed25519Thumbprint,
  isInnerList,
  parseDictionary,
  parseSignatures,
  signatureBase,
  verifySignature,
  type SignedMessage,
} from "../src/index";

/** The RFC 9421 B.2 test request. */
const REQUEST: SignedMessage = {
  method: "POST",
  url: "https://example.com/foo?param=Value&Pet=dog",
  fields: [
    ["Host", "example.com"],
    ["Date", "Tue, 20 Apr 2021 02:07:55 GMT"],
    ["Content-Type", "application/json"],
    ["Content-Digest", "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:"],
    ["Content-Length", "18"],
  ],
};

const innerOf = (header: string) => {
  const m = parseDictionary(header)[0]!;
  if (!isInnerList(m.value)) throw new Error("expected inner list");
  return m.value;
};

describe("RFC 9421 Appendix B.2.5 (HMAC-SHA256, test-shared-secret): signature base", () => {
  const INPUT = 'sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"';
  const RFC_BASE = [
    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
    '"@authority": example.com',
    '"content-type": application/json',
    '"@signature-params": ("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
  ].join("\n");
  const SECRET = "uzvJfB4u3N0Jy4T7NZ75MDVcr8zSTInedJtkgcu46YW4XByzNJjxBdtjUkdJPBtbmHhIDi6pcl8jsasjlTMtDQ==";
  const RFC_SIG = "pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=";

  it("reproduces the published signature base exactly", () => {
    const base = signatureBase(REQUEST, innerOf(INPUT));
    expect(base).toEqual({ ok: true, value: RFC_BASE });
  });

  it("the published signature is the HMAC of that base", async () => {
    const base = signatureBase(REQUEST, innerOf(INPUT));
    if (!base.ok) throw new Error("no base");
    const key = await crypto.subtle.importKey("raw", new Uint8Array(bytesFromBase64(SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base.value)));
    expect(base64FromBytes(mac)).toBe(RFC_SIG);
  });
});

describe("RFC 9421 Appendix B.2.6 (ed25519, test-key-ed25519)", () => {
  const PUBLIC_JWK = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" } as const;
  const INPUT = 'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
  const SIG = "wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==";
  const RFC_BASE = [
    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
    '"@method": POST',
    '"@path": /foo',
    '"@authority": example.com',
    '"content-type": application/json',
    '"content-length": 18',
    '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
  ].join("\n");

  const signed = (over: Partial<SignedMessage> = {}, sig = SIG): SignedMessage => ({
    ...REQUEST,
    ...over,
    fields: [...(over.fields ?? REQUEST.fields), ["Signature-Input", INPUT], ["Signature", `sig-b26=:${sig}:`]],
  });

  it("reproduces the published signature base exactly", () => {
    expect(signatureBase(REQUEST, innerOf(INPUT))).toEqual({ ok: true, value: RFC_BASE });
  });

  it("the published signature verifies against the published key", async () => {
    const parsed = parseSignatures(signed());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]!.label).toBe("sig-b26");
    expect(parsed.value[0]!.params.keyid).toBe("test-key-ed25519");
    expect(await verifySignature(signed(), parsed.value[0]!, PUBLIC_JWK)).toEqual({ ok: true, value: true });
  });

  it("flipping one byte of the signature fails", async () => {
    const bad = SIG.replace("wqcA", "wqcB");
    const parsed = parseSignatures(signed({}, bad));
    if (!parsed.ok) throw new Error("parse");
    expect(await verifySignature(signed({}, bad), parsed.value[0]!, PUBLIC_JWK)).toEqual({ ok: true, value: false });
  });

  it("changing a covered component (the path) fails", async () => {
    const msg = signed({ url: "https://example.com/bar?param=Value&Pet=dog" });
    const parsed = parseSignatures(msg);
    if (!parsed.ok) throw new Error("parse");
    expect(await verifySignature(msg, parsed.value[0]!, PUBLIC_JWK)).toEqual({ ok: true, value: false });
  });
});

describe("RFC 8037 Appendix A.3 thumbprint", () => {
  it("reproduces the normative vector", async () => {
    expect(await ed25519Thumbprint({ crv: "Ed25519", kty: "OKP", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })).toBe(
      "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
    );
  });

  it("ignores decoration a directory may add to a key", async () => {
    const plain = await ed25519Thumbprint({ crv: "Ed25519", kty: "OKP", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" });
    const decorated = await ed25519Thumbprint({ crv: "Ed25519", kty: "OKP", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs", kid: "x", use: "sig" } as never);
    expect(decorated).toBe(plain);
    expect(plain).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
  });
});
