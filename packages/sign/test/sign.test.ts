import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  sha256Hex,
  toBase64Url,
  fromBase64Url,
  fromHex,
  generateKeyPair,
  importKeyPair,
  thumbprint,
  signBytes,
  verifyBytes,
  contentId,
  contentIdOfBytes,
  isContentId,
  signManifest,
  verifyManifest,
  signDetached,
  verifyDetached,
  buildJwks,
  readJwks,
  verify,
  type Jwk,
} from "../src/index";

const vec = <T,>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../conformance/sign-vectors/${name}`, import.meta.url)), "utf8")) as T;

function fromIeee(hex: string): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt("0x" + hex));
  return dv.getFloat64(0);
}

describe("JCS (RFC 8785)", () => {
  it("serialises numbers per RFC 8785 Appendix B", () => {
    const { vectors } = vec<{ vectors: { ieee: string; expected: string | null }[] }>("jcs-numbers.json");
    for (const v of vectors) {
      const n = fromIeee(v.ieee);
      if (v.expected === null) expect(() => canonicalize(n), v.ieee).toThrow(/non-finite/);
      else expect(canonicalize(n), v.ieee).toBe(v.expected);
    }
  });

  it("reproduces the RFC 8785 section 3.2.2 example", () => {
    const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"/","literals":[null,true,false]}');
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    expect(canonicalize(input)).toBe(expected);
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // Read the order from the canonical text itself (JSON.parse would reorder integer-like keys).
    const c = canonicalize(input);
    const order = ["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"];
    const at = order.map((v) => c.indexOf(`"${v}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // Code-unit order puts the surrogate pair (U+D83D) before U+FB33, unlike code-point order.
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is whitespace-free, recursive and independent of insertion order", () => {
    expect(canonicalize({ z: [1, { y: 2, x: 1 }], a: null })).toBe('{"a":null,"z":[1,{"x":1,"y":2}]}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("omits undefined members but refuses data it cannot represent faithfully", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize([undefined])).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
    expect(() => canonicalize({ a: new Date() })).toThrow(/non-plain/);
    expect(() => canonicalize("\ud800")).toThrow(/surrogate/);
    expect(() => canonicalize(NaN)).toThrow();
  });
});

describe("sha256 + content ids", () => {
  it("sha256 hex matches the known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("ids are ispk_ + base64url(sha256(canonical bytes)) and ignore key order", async () => {
    const a = await contentId({ b: 1, a: [true] });
    expect(a).toBe(await contentId({ a: [true], b: 1 }));
    expect(isContentId(a)).toBe(true);
    expect(a).toMatch(/^ispk_[A-Za-z0-9_-]{43}$/);
    expect(await contentId({ a: [false], b: 1 })).not.toBe(a);
    expect(await contentIdOfBytes("abc")).toBe("ispk_" + toBase64Url(fromHex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")));
  });
  it("base64url is strict", () => {
    expect(() => fromBase64Url("ab=")).toThrow();
    expect(() => fromBase64Url("a+b/")).toThrow();
    expect(toBase64Url(fromBase64Url("_-8"))).toBe("_-8");
  });
});

describe("Ed25519 keys", () => {
  it("matches RFC 8032 test vectors (JWK import, deterministic signature)", async () => {
    const { vectors } = vec<{ vectors: { seed: string; public: string; message: string; signature: string }[] }>("ed25519-rfc8032.json");
    for (const v of vectors) {
      const jwk: Jwk = { kty: "OKP", crv: "Ed25519", x: toBase64Url(fromHex(v.public)), d: toBase64Url(fromHex(v.seed)) };
      const sig = await signBytes(jwk, fromHex(v.message));
      expect(sig).toBe(toBase64Url(fromHex(v.signature)));
      expect(await verifyBytes(jwk, sig, fromHex(v.message))).toBe(true);
    }
  });

  it("generates a pair whose kid is the RFC 7638 thumbprint, and round-trips through JSON", async () => {
    const kp = await generateKeyPair();
    expect(kp.kid).toBe(await thumbprint(kp.publicKey));
    expect(kp.privateKey.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kp.publicKey).not.toHaveProperty("d");
    const again = await importKeyPair(JSON.parse(JSON.stringify(kp.privateKey)));
    expect(again.kid).toBe(kp.kid);
    expect(again.publicKey).toEqual(kp.publicKey);
    const sig = await signBytes(again.privateKey, new Uint8Array([1, 2, 3]));
    expect(await verifyBytes(kp.publicKey, sig, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(await verifyBytes(kp.publicKey, sig, new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("RFC 7638 thumbprint of the RFC 8037 example key", async () => {
    // RFC 8037 appendix A.3: the OKP public key and its thumbprint.
    expect(await thumbprint({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("rejects a public-only JWK for signing", async () => {
    const kp = await generateKeyPair();
    await expect(signBytes(kp.publicKey as Jwk, new Uint8Array())).rejects.toThrow(/private/);
  });
});

const SHELL = {
  spec_version: "1.0",
  domain: "acme.example",
  issued_at: "2026-06-15T00:00:00.000Z",
  issuer: { name: "Acme" },
  usage: { train: "deny", index: "allow" },
  content_map: { pages: [{ path: "/", title: "Home", content_hash: "a".repeat(64) }] },
};
const SIGNED_AT = "2026-06-15T12:00:00.000Z";

describe("signManifest / verifyManifest", () => {
  it("round-trips, offline, using the embedded key", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    expect(m.provenance).toMatchObject({ algorithm: "Ed25519", canonicalization: "JCS/RFC8785", signed_at: SIGNED_AT, key_ref: kp.kid, public_key: kp.publicKey.x });
    expect(isContentId(m.provenance.content_id)).toBe(true);
    const r = await verifyManifest(JSON.parse(JSON.stringify(m)));
    expect(r).toMatchObject({ ok: true, code: "ok" });
    expect(r.details).toMatchObject({ domain: "acme.example", kid: kp.kid, signedAt: SIGNED_AT, contentId: m.provenance.content_id });
    expect(r.details.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (Ed25519 + JCS)", async () => {
    const kp = await generateKeyPair();
    const a = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const b = await signManifest({ ...SHELL, usage: { index: "allow", train: "deny" } }, kp.privateKey, { signedAt: SIGNED_AT });
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("changing deny to allow is caught as a content-address mismatch, before the signature", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const forged = JSON.parse(JSON.stringify(m));
    forged.usage.train = "allow";
    const r = await verifyManifest(forged);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("content_address_mismatch");
  });

  it("flipping one byte of the payload fails", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const text = JSON.stringify(m);
    const i = text.indexOf("acme.example");
    const tampered = text.slice(0, i) + "acme.exbmple" + text.slice(i + 12);
    expect((await verifyManifest(JSON.parse(tampered))).code).toBe("content_address_mismatch");
  });

  it("an attacker who recomputes the content id still fails the signature", async () => {
    const kp = await generateKeyPair();
    const m = JSON.parse(JSON.stringify(await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT })));
    m.usage.train = "allow";
    const { signature, anchor, content_id, ...prov } = m.provenance;
    m.provenance.content_id = await contentId({ ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== "provenance")), provenance: prov });
    const r = await verifyManifest(m);
    expect(r.code).toBe("signature_invalid");
  });

  it("a flipped signature byte fails; unknown provenance members are signed too", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const s = m.provenance.signature;
    const flipped = { ...m, provenance: { ...m.provenance, signature: (s[0] === "A" ? "B" : "A") + s.slice(1) } };
    expect((await verifyManifest(flipped)).code).toBe("signature_invalid");
    const extra = JSON.parse(JSON.stringify(m));
    extra.provenance.note = "added later";
    expect((await verifyManifest(extra)).code).toBe("content_address_mismatch");
  });

  it("an anchor can be added after signing without breaking the signature", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const anchored = { ...m, provenance: { ...m.provenance, anchor: { status: "pending" as const, attestation_id: "att_1" } } };
    const r = await verifyManifest(anchored);
    expect(r.ok).toBe(true);
    expect(r.details.anchorStatus).toBe("pending");
  });

  it("the wrong key fails (pinned key, JWKS by key_ref, swapped embedded key)", async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    expect((await verifyManifest(m, { publicKey: other.publicKey })).code).toBe("signature_invalid");
    expect((await verifyManifest(m, { publicKey: kp.publicKey })).ok).toBe(true);
    expect((await verifyManifest(m, { jwks: await buildJwks([other.publicKey]) })).code).toBe("no_public_key");
    expect((await verifyManifest(m, { jwks: await buildJwks([other.publicKey, kp.publicKey]) })).ok).toBe(true);
    // Embedded key swapped for another key while keeping the signature and key_ref.
    const swapped = { ...m, provenance: { ...m.provenance, public_key: other.publicKey.x } };
    expect(["content_address_mismatch", "key_mismatch"]).toContain((await verifyManifest(swapped)).code);
  });

  it("without an embedded key and without a pinned key there is nothing to verify against", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT, embedPublicKey: false });
    expect((await verifyManifest(m)).code).toBe("no_public_key");
    expect((await verifyManifest(m, { publicKey: kp.publicKey })).ok).toBe(true);
  });

  it("rejects unsigned, malformed and unsupported envelopes; flags expiry informationally", async () => {
    const kp = await generateKeyPair();
    expect((await verifyManifest(SHELL)).code).toBe("unsupported_envelope");
    expect((await verifyManifest("nope")).code).toBe("malformed");
    const m = await signManifest({ ...SHELL, expires_at: "2026-07-01T00:00:00Z" }, kp.privateKey, { signedAt: SIGNED_AT });
    expect((await verifyManifest({ ...m, provenance: { ...m.provenance, algorithm: "RS256" } })).code).toBe("unsupported_envelope");
    const late = await verifyManifest(m, { now: "2026-08-01T00:00:00Z" });
    expect(late.ok).toBe(true);
    expect(late.details.expired).toBe(true);
    await expect(signManifest(m, kp.privateKey)).rejects.toThrow(/already has a provenance/);
  });
});

describe("detached signatures", () => {
  const LLMS = "# Acme\n\n> Docs.\n\n## Pages\n\n- [Home](https://acme.example/index.md)\n";

  it("round-trips for text and bytes", async () => {
    const kp = await generateKeyPair();
    const env = await signDetached(LLMS, kp.privateKey, { signedAt: SIGNED_AT });
    expect(env).toMatchObject({ typ: "ispeakllm-detached/1", algorithm: "Ed25519", key_ref: kp.kid, signed_at: SIGNED_AT });
    expect(env.content_id).toBe(await contentIdOfBytes(LLMS));
    expect(await verifyDetached(LLMS, env, { publicKey: kp.publicKey })).toMatchObject({ ok: true, code: "ok" });
    expect((await verifyDetached(new TextEncoder().encode(LLMS), JSON.stringify(env), { publicKey: kp.publicKey })).ok).toBe(true);
    expect((await verifyDetached(LLMS, env, { jwks: await buildJwks([kp.publicKey]) })).ok).toBe(true);
  });

  it("a changed byte, a forged envelope or the wrong key fails", async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    const env = await signDetached(LLMS, kp.privateKey, { signedAt: SIGNED_AT });
    expect((await verifyDetached(LLMS.replace("Docs", "Dots"), env, { publicKey: kp.publicKey })).code).toBe("content_address_mismatch");
    expect((await verifyDetached(LLMS, env, { publicKey: other.publicKey })).code).toBe("signature_invalid");
    expect((await verifyDetached(LLMS, { ...env, signed_at: "2030-01-01T00:00:00Z" }, { publicKey: kp.publicKey })).code).toBe("signature_invalid");
    expect((await verifyDetached(LLMS, { ...env, key_ref: "x" }, { publicKey: kp.publicKey })).code).toBe("signature_invalid");
    // A signature made for other bytes, relabelled with this content id, fails the signature check.
    const forged = { ...(await signDetached("other", kp.privateKey, { signedAt: SIGNED_AT })), content_id: env.content_id };
    expect((await verifyDetached(LLMS, forged, { publicKey: kp.publicKey })).code).toBe("signature_invalid");
    expect((await verifyDetached(LLMS, env, {})).code).toBe("no_public_key");
    expect((await verifyDetached(LLMS, "not json", { publicKey: kp.publicKey })).code).toBe("malformed");
  });

  it("is not interchangeable with a manifest signature", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    const asEnv = { typ: "ispeakllm-detached/1", algorithm: "Ed25519", key_ref: kp.kid, signed_at: SIGNED_AT, content_id: await contentIdOfBytes("x"), signature: m.provenance.signature };
    expect((await verifyDetached("x", asEnv, { publicKey: kp.publicKey })).ok).toBe(false);
  });
});

describe("JWKS", () => {
  it("builds public-only, sorted, de-duplicated and reads back", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const jwks = await buildJwks([a.privateKey, b.publicKey, a.publicKey]);
    expect(jwks.keys.length).toBe(2);
    expect(JSON.stringify(jwks)).not.toContain('"d"');
    expect(jwks.keys.map((k) => k.kid)).toEqual([a.kid, b.kid].sort());
    const read = await readJwks(JSON.stringify(jwks));
    expect(read.get(a.kid)).toEqual(jwks.keys.find((k) => k.kid === a.kid));
    expect(read.get("missing")).toBeUndefined();
    expect(await thumbprint(read.get(b.kid)!)).toBe(b.kid);
  });

  it("the reader skips unsupported keys and rejects non-JWKS documents", async () => {
    const a = await generateKeyPair();
    const read = await readJwks({ keys: [{ kty: "RSA", n: "x", e: "AQAB", kid: "r" }, { ...a.publicKey, kid: undefined }] });
    expect(read.keys.map((k) => k.kid)).toEqual([a.kid]);
    await expect(readJwks({ nope: 1 })).rejects.toThrow(/JWKS/);
    await expect(buildJwks([{ kty: "RSA" } as never])).rejects.toThrow();
  });
});

describe("verify() entry", () => {
  it("verifies manifests (object or text) and detached signatures with one verdict shape", async () => {
    const kp = await generateKeyPair();
    const m = await signManifest(SHELL, kp.privateKey, { signedAt: SIGNED_AT });
    expect(await verify({ kind: "manifest", manifest: JSON.stringify(m) })).toMatchObject({ kind: "manifest", ok: true });
    const jwks = await buildJwks([kp.publicKey]);
    expect(await verify({ kind: "manifest", manifest: m }, { jwks: JSON.stringify(jwks) })).toMatchObject({ ok: true, details: { pinnedKey: true } });
    const other = await generateKeyPair();
    expect((await verify({ kind: "manifest", manifest: m }, { publicKey: JSON.stringify(other.publicKey) })).ok).toBe(false);
    const env = await signDetached("hello", kp.privateKey, { signedAt: SIGNED_AT });
    expect(await verify({ kind: "detached", bytes: "hello", signature: env }, { publicKey: kp.publicKey })).toMatchObject({ kind: "detached", ok: true });
    expect((await verify({ kind: "detached", bytes: "hellp", signature: env }, { publicKey: kp.publicKey })).code).toBe("content_address_mismatch");
    expect((await verify({ kind: "manifest", manifest: "{" })).code).toBe("malformed");
    expect((await verify({ kind: "manifest", manifest: m }, { jwks: "{" })).code).toBe("malformed");
  });
});

describe("ACM schema", () => {
  it("parses and declares the content-addressed provenance member", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/acm/acm.schema.json", import.meta.url)), "utf8"));
    expect(schema.required).toContain("provenance");
    expect(schema.properties.provenance.properties.content_id.pattern).toBe("^ispk_[A-Za-z0-9_-]{43}$");
    expect(JSON.stringify(schema)).not.toMatch(/goplainly|trustvice|entpoind/i);
  });
});
