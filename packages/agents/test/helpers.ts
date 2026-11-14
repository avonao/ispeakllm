// Test helper: sign a request with RFC 9421's test-key-ed25519 (key material this repo does not control).
import { base64FromBytes, isInnerList, parseDictionary, signatureBase, type SignedMessage } from "../src/index";

export const PUBLIC_JWK = { kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" } as const;
export const PRIVATE_JWK = { ...PUBLIC_JWK, d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU" } as const;
/** RFC 8037 thumbprint of the test key: what Web Bot Auth requires as `keyid`. */
export const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
export const NOW = new Date("2026-11-14T12:00:00Z");
export const NOW_S = Math.floor(NOW.getTime() / 1000);

export async function sign(opts: {
  url?: string;
  components?: string;
  fields?: ReadonlyArray<readonly [string, string]>;
  keyid?: string;
  created?: number;
  expires?: number;
} = {}): Promise<SignedMessage> {
  const url = opts.url ?? "https://site.example/llms.txt";
  const input = `sig1=(${opts.components ?? '"@authority"'});created=${opts.created ?? NOW_S - 10};expires=${opts.expires ?? NOW_S + 3600};keyid="${opts.keyid ?? KEYID}";tag="web-bot-auth"`;
  const unsigned: SignedMessage = { method: "GET", url, fields: [["Host", new URL(url).host], ...(opts.fields ?? [])] };
  const member = parseDictionary(input)[0]!.value;
  if (!isInnerList(member)) throw new Error("inner list");
  const base = signatureBase(unsigned, member);
  if (!base.ok) throw new Error(base.error.detail);
  const key = await crypto.subtle.importKey("jwk", PRIVATE_JWK as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(base.value));
  return { ...unsigned, fields: [...unsigned.fields, ["Signature-Input", input], ["Signature", `sig1=:${base64FromBytes(new Uint8Array(sig))}:`]] };
}
