// New for iSpeakLLM: the strict RFC 8941 subset used by RFC 9421.
import { describe, expect, it } from "vitest";
import {
  SfError,
  isInnerList,
  messageFromRequest,
  parseDictionary,
  parseItem,
  parseSignatures,
  serializeInnerList,
} from "../src/index";

describe("structured fields", () => {
  it("parses a Signature-Input member, keeping parameters and the raw member text", () => {
    const [m] = parseDictionary('sig1=("@authority" "x-y";key="k");created=1;keyid="a\\"b";tag=web-bot-auth;flag');
    expect(m!.key).toBe("sig1");
    expect(isInnerList(m!.value)).toBe(true);
    if (!isInnerList(m!.value)) return;
    expect(m!.value.members.map((x) => (x.value as { value: string }).value)).toEqual(["@authority", "x-y"]);
    expect(m!.value.params.map(([k]) => k)).toEqual(["created", "keyid", "tag", "flag"]);
    expect(m!.raw.startsWith('("@authority"')).toBe(true);
  });

  it("re-serialises canonically: odd spacing on the wire does not change the signature base input", () => {
    const [m] = parseDictionary('sig1=(  "a"   "b" );created=1;keyid="k"');
    expect(serializeInnerList(m!.value as never)).toBe('("a" "b");created=1;keyid="k"');
  });

  it("parses several members, byte sequences, booleans and a bare string item", () => {
    const d = parseDictionary("a=:AQID:, b=?0, c");
    expect(d.map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(parseItem('"https://chatgpt.com"').value).toEqual({ type: "string", value: "https://chatgpt.com" });
  });

  it("rejects anything it does not understand", () => {
    for (const bad of ['sig1=("a"', "sig1=", 'sig1="unterminated', "SIG=1", "a=1,", "a=1 b=2", "a=:not base64!:", "a=?2", 'a="\\x"', "a=1.2345"]) {
      expect(() => parseDictionary(bad), bad).toThrow(SfError);
    }
  });
});

describe("signature header handling", () => {
  it("messageFromRequest carries the method, url and headers", () => {
    const m = messageFromRequest(new Request("https://site.example/a?b=1", { method: "POST", headers: { "User-Agent": "x" } }));
    expect(m.method).toBe("POST");
    expect(m.url).toBe("https://site.example/a?b=1");
    expect(m.fields).toContainEqual(["user-agent", "x"]);
  });

  it("no signature headers is an empty list (unauthenticated), not an error", () => {
    expect(parseSignatures({ method: "GET", url: "https://site.example/", fields: [] })).toEqual({ ok: true, value: [] });
  });

  it("garbage in either header is a typed error", () => {
    const f = (i: string, s: string) => parseSignatures({ method: "GET", url: "https://site.example/", fields: [["Signature-Input", i], ["Signature", s]] });
    expect(f("???", "sig1=:AA==:")).toMatchObject({ ok: false, error: { code: "malformed_signature_input" } });
    expect(f('sig1=("@authority");created=1', "???")).toMatchObject({ ok: false, error: { code: "malformed_signature" } });
    expect(f('sig1=("@authority");created="x"', "sig1=:AA==:")).toMatchObject({ ok: false, error: { code: "malformed_signature_input" } });
    expect(f('sig1=("@authority");created=1', "other=:AA==:")).toMatchObject({ ok: false, error: { code: "no_signature" } });
  });
});
