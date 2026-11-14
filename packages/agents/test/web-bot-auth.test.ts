// Ported from runtime/shared/web-bot-auth.test.ts (consentrack-v1-2026-10-30-fetch-ledger)
//
// Web Bot Auth policy: which outcome is allowed to be called what. These tests
// sign locally with RFC 9421's own test-key-ed25519; canonicalisation is anchored
// externally in rfc-vectors.test.ts. The central assertion: `failed` appears only
// when the crypto ran and said no, or when the claim expired / is dated in the
// future. Every other unhappy path is `unchecked`.
import { describe, expect, it } from "vitest";
import {
  base64FromBytes,
  ed25519Thumbprint,
  isInnerList,
  parseDictionary,
  signatureBase,
  verifyWebBotAuth,
  type KeyResolver,
  type ResolvedKey,
  type SignedMessage,
} from "../src/index";

/* RFC 9421 Appendix B.1.4 — test-key-ed25519. */
const PUBLIC_JWK = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" } as const;
const PRIVATE_JWK = { ...PUBLIC_JWK, d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU" } as const;
/** Its RFC 8037 thumbprint, which Web Bot Auth requires as the keyid. */
const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

const NOW = new Date("2026-03-01T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

const directoryKey: ResolvedKey = { jwk: PUBLIC_JWK, source: "directory" };
const resolves: KeyResolver = async () => directoryKey;
const resolvesNothing: KeyResolver = async () => null;

type SignOpts = {
  readonly components?: string;
  readonly created?: number;
  readonly expires?: number;
  readonly tag?: string | null;
  readonly keyid?: string | null;
  readonly extraFields?: ReadonlyArray<readonly [string, string]>;
  readonly url?: string;
};

/** Produce a genuinely signed request, then hand it to the verifier. */
async function signed(opts: SignOpts = {}): Promise<SignedMessage> {
  const components = opts.components ?? '"@authority"';
  const created = opts.created ?? NOW_S - 10;
  const expires = opts.expires ?? NOW_S + 3600;
  const keyid = opts.keyid === undefined ? KEYID : opts.keyid;
  const tag = opts.tag === undefined ? "web-bot-auth" : opts.tag;

  let params = `;created=${created};expires=${expires}`;
  if (keyid !== null) params += `;keyid="${keyid}"`;
  if (tag !== null) params += `;tag="${tag}"`;
  const inputHeader = `sig1=(${components})${params}`;

  const unsigned: SignedMessage = {
    method: "GET",
    url: opts.url ?? "https://site.example/labels/acme",
    fields: [["Host", "site.example"], ...(opts.extraFields ?? [])],
  };

  const member = parseDictionary(inputHeader)[0]!.value;
  if (!isInnerList(member)) throw new Error("expected inner list");
  const base = signatureBase(unsigned, member);
  if (!base.ok) throw new Error(`${base.error.code}: ${base.error.detail}`);

  const key = await crypto.subtle.importKey("jwk", PRIVATE_JWK as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(base.value),
  );

  return {
    ...unsigned,
    fields: [
      ...unsigned.fields,
      ["Signature-Input", inputHeader],
      ["Signature", `sig1=:${base64FromBytes(new Uint8Array(sig))}:`],
    ],
  };
}

describe("the thumbprint that Web Bot Auth uses as a keyid", () => {
  it("reproduces the RFC 8037 Appendix A.3 vector", async () => {
    // The normative example. The Web Bot Auth draft's own illustrative `kid`
    // values are not derived from the keys printed beside them, so this — not
    // the draft's prose — is what the implementation is anchored to.
    const thumb = await ed25519Thumbprint({
      crv: "Ed25519",
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    });
    expect(thumb).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("ignores decoration a directory may add to a key", async () => {
    const plain = await ed25519Thumbprint(PUBLIC_JWK);
    const decorated = await ed25519Thumbprint({ ...PUBLIC_JWK, kid: "anything", use: "sig" } as never);
    expect(decorated).toBe(plain);
    expect(plain).toBe(KEYID);
  });
});

describe("verified", () => {
  it("a well-formed, live, resolvable signature verifies", async () => {
    const v = await verifyWebBotAuth(await signed(), { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("verified");
    expect(v.keyid).toBe(KEYID);
    expect(v.label).toBe("sig1");
  });

  it("@target-uri satisfies the binding requirement as well as @authority", async () => {
    const v = await verifyWebBotAuth(await signed({ components: '"@target-uri"' }), { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("verified");
  });

  it("an out-of-band key may carry any keyid the operator agreed to", async () => {
    // §4.5.1 allows keys shared out of band; imposing the thumbprint rule there
    // would break working private arrangements.
    const outOfBand: KeyResolver = async () => ({ jwk: PUBLIC_JWK, source: "out-of-band", operator: "Acme Crawler" });
    const v = await verifyWebBotAuth(await signed({ keyid: "acme-2026-key-1" }), { now: NOW, resolveKey: outOfBand });
    expect(v.grade).toBe("verified");
    expect(v.operator).toBe("Acme Crawler");
  });
});

describe("failed — the accusation, and its two permitted causes", () => {
  it("the crypto said no", async () => {
    const msg = await signed();
    const tampered: SignedMessage = { ...msg, url: "https://someone-else.example/labels/acme" };
    const v = await verifyWebBotAuth(tampered, { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("failed");
    expect(v.code).toBe("bad_signature");
  });

  it("the claim has expired", async () => {
    const v = await verifyWebBotAuth(await signed({ created: NOW_S - 7200, expires: NOW_S - 3600 }), {
      now: NOW,
      resolveKey: resolves,
    });
    expect(v.grade).toBe("failed");
    expect(v.code).toBe("expired");
  });

  it("the claim is dated in the future", async () => {
    const v = await verifyWebBotAuth(await signed({ created: NOW_S + 3600, expires: NOW_S + 7200 }), {
      now: NOW,
      resolveKey: resolves,
    });
    expect(v.grade).toBe("failed");
    expect(v.code).toBe("created_in_future");
  });

  it("MALFORMED headers are NOT failed — we never read the claim", async () => {
    // The subtle one. `Signature-Input` without `Signature` looks like a signer
    // error, but we cannot tell what was claimed and cannot build a base, so
    // nothing has been disproven. `failed` here would assert that a claim did
    // not stand up when we never read the claim.
    const half: SignedMessage = {
      method: "GET",
      url: "https://site.example/x",
      fields: [["Signature-Input", 'sig1=("@authority");created=1;expires=2;tag="web-bot-auth"']],
    };
    const v = await verifyWebBotAuth(half, { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("no_signature");
  });

  it("a Signature with no Signature-Input is unchecked too", async () => {
    const v = await verifyWebBotAuth(
      { method: "GET", url: "https://site.example/x", fields: [["Signature", "sig1=:AAA:"]] },
      { now: NOW, resolveKey: resolves },
    );
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("no_signature_input");
  });

  it("clock skew inside the tolerance is NOT a failure", async () => {
    // 30 seconds past expiry, default tolerance 60. A crawler with a slightly
    // fast clock is not a forger.
    const v = await verifyWebBotAuth(await signed({ created: NOW_S - 600, expires: NOW_S - 30 }), {
      now: NOW,
      resolveKey: resolves,
    });
    expect(v.grade).toBe("verified");
  });
});

describe("unchecked — everything we could not check, and nothing we could", () => {
  const cases: ReadonlyArray<readonly [string, () => Promise<SignedMessage>, KeyResolver, string]> = [
    ["the key is unknown to us", () => signed(), resolvesNothing, "unknown_key"],
    [
      "the directory could not be reached",
      () => signed(),
      async () => {
        throw new Error("dns failure");
      },
      "resolver_unavailable",
    ],
    [
      "the directory served the key under the wrong id",
      () => signed({ keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r1X" }),
      resolves,
      "keyid_thumbprint_mismatch",
    ],
    ["the signature carries no keyid", () => signed({ keyid: null }), resolves, "no_keyid"],
    [
      "the signature is bound to no part of this request",
      () => signed({ components: '"host"', extraFields: [] }),
      resolves,
      "no_bound_component",
    ],
    ["the signature is not a bot-identity claim", () => signed({ tag: "other-purpose" }), resolves, "not_web_bot_auth"],
    [
      "the resolved key is not one we can use",
      () => signed(),
      async () => ({ jwk: { kty: "RSA", n: "…", e: "AQAB" }, source: "out-of-band" }),
      "unusable_key",
    ],
  ];

  for (const [name, build, resolver, code] of cases) {
    it(`${name} → unchecked (${code})`, async () => {
      const v = await verifyWebBotAuth(await build(), { now: NOW, resolveKey: resolver });
      expect(v.grade).toBe("unchecked");
      expect(v.code).toBe(code);
    });
  }

  it("a covered field the message no longer carries is unchecked, not failed", async () => {
    // A proxy that strips a signed header is at least as likely as a forger,
    // and a forger gains nothing by omitting one.
    const msg = await signed({ components: '"@authority" "x-signed-by-client"', extraFields: [["X-Signed-By-Client", "v"]] });
    const stripped: SignedMessage = { ...msg, fields: msg.fields.filter(([n]) => n !== "X-Signed-By-Client") };
    const v = await verifyWebBotAuth(stripped, { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("missing_field");
  });

  it("a validity window longer than the origin allows is unchecked", async () => {
    const v = await verifyWebBotAuth(await signed({ created: NOW_S - 10, expires: NOW_S + 90000 }), {
      now: NOW,
      resolveKey: resolves,
      maxValiditySeconds: 86400,
    });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("validity_window_too_long");
  });

  it("a signature with no validity window at all is unchecked", async () => {
    const noWindow: SignedMessage = {
      method: "GET",
      url: "https://site.example/x",
      fields: [
        ["Signature-Input", 'sig1=("@authority");keyid="k";tag="web-bot-auth"'],
        ["Signature", "sig1=:AAAA:"],
      ],
    };
    const v = await verifyWebBotAuth(noWindow, { now: NOW, resolveKey: resolves });
    expect(v.grade).toBe("unchecked");
    expect(v.code).toBe("no_validity_window");
  });
});

describe("unauthenticated", () => {
  it("an unsigned request is not an accusation", async () => {
    const v = await verifyWebBotAuth(
      { method: "GET", url: "https://site.example/x", fields: [["User-Agent", "SomeBot/1.0"]] },
      { now: NOW, resolveKey: resolves },
    );
    expect(v.grade).toBe("unauthenticated");
    expect(v.code).toBe("unsigned");
    expect(v.operator).toBeNull();
  });
});

describe("Signature-Agent may only be trusted when it is signed", () => {
  const AGENT = 'sig1="https://directory.example"';

  it("a signed Signature-Agent is passed to the resolver and names the operator", async () => {
    const msg = await signed({
      components: '"@authority" "signature-agent";key="sig1"',
      extraFields: [["Signature-Agent", AGENT]],
    });
    const seen: Array<string | null> = [];
    const v = await verifyWebBotAuth(msg, {
      now: NOW,
      resolveKey: async (_id, agent) => {
        seen.push(agent);
        return directoryKey;
      },
    });
    expect(v.grade).toBe("verified");
    expect(seen).toEqual(["https://directory.example"]);
    expect(v.signatureAgent).toBe("https://directory.example");
    expect(v.operator).toBe("directory.example");
  });

  it("an UNSIGNED Signature-Agent is ignored — anyone can add that header in flight", async () => {
    const msg = await signed({ extraFields: [["Signature-Agent", 'sig1="https://attacker.example"']] });
    const seen: Array<string | null> = [];
    const v = await verifyWebBotAuth(msg, {
      now: NOW,
      resolveKey: async (_id, agent) => {
        seen.push(agent);
        return directoryKey;
      },
    });
    expect(v.grade).toBe("verified");
    // The resolver was never told about the attacker's directory.
    expect(seen).toEqual([null]);
    expect(v.signatureAgent).toBeNull();
  });

  it("a plaintext directory cannot bind an identity", async () => {
    const msg = await signed({
      components: '"@authority" "signature-agent";key="sig1"',
      extraFields: [["Signature-Agent", 'sig1="http://directory.example"']],
    });
    const v = await verifyWebBotAuth(msg, { now: NOW, resolveKey: resolves });
    expect(v.signatureAgent).toBeNull();
  });
});
