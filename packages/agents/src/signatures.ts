// Ported from runtime/shared/web-bot-auth.ts + http-message-signatures usage (consentrack-v1-2026-10-30-fetch-ledger),
// with signature-base ideas from runtime/emissary/src/web-bot-auth.ts (trustvice-v3-2026-11-10-current).
//
// RFC 9421 HTTP Message Signatures: parsing Signature-Input / Signature,
// building the signature base (section 2.5) and verifying ed25519.
//
// Anything the base builder cannot reproduce faithfully (an unimplemented
// component, a component parameter we refuse to guess at, a covered field the
// message no longer carries) is a typed error, never a skipped line: verifying
// a base the signer did not sign either fails confusingly or, with the wrong
// bug, succeeds on a message the signature does not cover.

import {
  SfError,
  bytesFromBase64,
  isInnerList,
  paramOf,
  parseDictionary,
  parseItem,
  serializeInnerList,
  serializeItem,
  type InnerList,
  type Item,
} from "./structured-fields";

export type SignedMessage = {
  readonly method: string;
  /** Absolute URL as received. */
  readonly url: string;
  /** Header fields as received, repeats allowed. */
  readonly fields: ReadonlyArray<readonly [string, string]>;
};

export type SigError = { readonly code: string; readonly detail: string };
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SigError };
const err = (code: string, detail: string): { ok: false; error: SigError } => ({ ok: false, error: { code, detail } });
const okv = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/** Build a SignedMessage from a standard Request. */
export function messageFromRequest(request: Request): SignedMessage {
  const fields: Array<readonly [string, string]> = [];
  request.headers.forEach((v, k) => fields.push([k, v]));
  return { method: request.method, url: request.url, fields };
}

/** All values of a field, joined with ", " (RFC 9421 2.1), or null when absent. */
export function fieldValue(message: SignedMessage, name: string): string | null {
  const lower = name.toLowerCase();
  const vs = message.fields.filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v.replace(/\r?\n[ \t]+/g, " ").trim());
  return vs.length === 0 ? null : vs.join(", ");
}

export type SignatureParams = {
  readonly created: number | null;
  readonly expires: number | null;
  readonly keyid: string | null;
  readonly alg: string | null;
  readonly tag: string | null;
  readonly nonce: string | null;
};

export type ParsedSignature = {
  readonly label: string;
  /** The covered components and signature parameters, as parsed. */
  readonly input: InnerList;
  /** Alias of `input` for readability: the covered component list. */
  readonly covered: InnerList;
  readonly params: SignatureParams;
  readonly signature: Uint8Array;
};

function stringParam(l: InnerList, key: string): string | null | "bad" {
  const p = paramOf(l.params, key);
  if (p === undefined) return null;
  return p.type === "string" ? p.value : "bad";
}
function intParam(l: InnerList, key: string): number | null | "bad" {
  const p = paramOf(l.params, key);
  if (p === undefined) return null;
  return p.type === "integer" ? p.value : "bad";
}

/**
 * Read every labelled signature on the message.
 *
 * `[]` means the message carries no signature at all (unauthenticated). An
 * error means a signature was offered but could not be read: that is NOT the
 * same as one that failed, because we could not tell what was claimed.
 */
export function parseSignatures(message: SignedMessage): Result<ParsedSignature[]> {
  const inputRaw = fieldValue(message, "signature-input");
  const sigRaw = fieldValue(message, "signature");
  if (inputRaw === null && sigRaw === null) return okv([]);
  if (inputRaw === null) return err("no_signature_input", "A Signature header arrived without a Signature-Input, so the claim cannot be read.");
  if (sigRaw === null) return err("no_signature", "A Signature-Input arrived without a Signature, so there is nothing to check.");

  let inputs, sigs;
  try {
    inputs = parseDictionary(inputRaw);
  } catch (e) {
    return err("malformed_signature_input", `Signature-Input could not be parsed: ${(e as Error).message}`);
  }
  try {
    sigs = parseDictionary(sigRaw);
  } catch (e) {
    return err("malformed_signature", `Signature could not be parsed: ${(e as Error).message}`);
  }

  const out: ParsedSignature[] = [];
  for (const { key: label, value } of inputs) {
    if (!isInnerList(value)) return err("malformed_signature_input", `Signature-Input member "${label}" is not an inner list.`);
    for (const m of value.members) {
      if (m.value.type !== "string") return err("malformed_signature_input", "A covered component identifier is not a string.");
    }
    const sigMember = sigs.find((s) => s.key === label)?.value;
    if (!sigMember) continue;
    if (isInnerList(sigMember) || sigMember.value.type !== "bytes") {
      return err("malformed_signature", `Signature member "${label}" is not a byte sequence.`);
    }
    const created = intParam(value, "created");
    const expires = intParam(value, "expires");
    const keyid = stringParam(value, "keyid");
    const alg = stringParam(value, "alg");
    const tag = stringParam(value, "tag");
    const nonce = stringParam(value, "nonce");
    if ([created, expires, keyid, alg, tag, nonce].includes("bad" as never)) {
      return err("malformed_signature_input", `Signature parameters of "${label}" have the wrong type.`);
    }
    out.push({
      label,
      input: value,
      covered: value,
      params: { created, expires, keyid, alg, tag, nonce } as SignatureParams,
      signature: sigMember.value.value,
    });
  }
  if (out.length === 0) return err("no_signature", "No Signature value matches any Signature-Input label.");
  return okv(out);
}

/* ── Signature base (RFC 9421 section 2.5) ──────────────────────────── */

function derived(name: string, message: SignedMessage): string | null {
  let url: URL;
  try {
    url = new URL(message.url);
  } catch {
    return null;
  }
  switch (name) {
    case "@method":
      return message.method.toUpperCase();
    case "@authority":
      return url.host.toLowerCase();
    case "@scheme":
      return url.protocol.replace(/:$/, "").toLowerCase();
    case "@target-uri":
      return url.href;
    case "@request-target":
      return `${url.pathname}${url.search}`;
    case "@path":
      return url.pathname === "" ? "/" : url.pathname;
    case "@query":
      return url.search === "" ? "?" : url.search;
    default:
      return null;
  }
}

/**
 * Build the signature base for a covered-components list with its signature
 * parameters. Errors: `unsupported_component`, `unsupported_component_param`,
 * `missing_field` (a covered field the message does not carry: a proxy is at
 * least as likely as a forger, so this is never an accusation).
 */
export function signatureBase(message: SignedMessage, input: InnerList): Result<string> {
  const lines: string[] = [];
  for (const m of input.members) {
    if (m.value.type !== "string") return err("unsupported_component", "Component identifiers must be strings.");
    const name = m.value.value;
    const id = serializeItem(m);
    if (name.startsWith("@")) {
      if (m.params.length > 0) return err("unsupported_component_param", `Component ${id} carries parameters this verifier does not implement.`);
      const v = derived(name, message);
      if (v === null) return err("unsupported_component", `Component "${name}" is not implemented or the URL is unusable.`);
      lines.push(`${id}: ${v}`);
      continue;
    }
    if (name !== name.toLowerCase()) return err("unsupported_component", `Field names must be lower-case: "${name}".`);
    const raw = fieldValue(message, name);
    const keyParam = paramOf(m.params, "key");
    const unsupported = m.params.filter(([k]) => k !== "key");
    if (unsupported.length > 0) return err("unsupported_component_param", `Component ${id} carries parameters this verifier does not implement.`);
    if (raw === null) return err("missing_field", `The signature covers "${name}" but the message does not carry it.`);
    if (keyParam !== undefined) {
      if (keyParam.type !== "string") return err("unsupported_component_param", "The key parameter must be a string.");
      let dict;
      try {
        dict = parseDictionary(raw);
      } catch {
        return err("unsupported_component_param", `Field "${name}" is not a dictionary, so ;key cannot apply.`);
      }
      const member = dict.find((d) => d.key === keyParam.value);
      if (!member) return err("missing_field", `Field "${name}" has no dictionary member "${keyParam.value}".`);
      lines.push(`${id}: ${member.raw.trim()}`);
      continue;
    }
    lines.push(`${id}: ${raw}`);
  }
  try {
    lines.push(`"@signature-params": ${serializeInnerList(input)}`);
  } catch (e) {
    return err("unsupported_component_param", (e as SfError).message);
  }
  return okv(lines.join("\n"));
}

/* ── ed25519 ────────────────────────────────────────────────────────── */

export type Ed25519Jwk = { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };

export function isEd25519Jwk(k: unknown): k is Ed25519Jwk {
  if (typeof k !== "object" || k === null) return false;
  const o = k as Record<string, unknown>;
  return o.kty === "OKP" && o.crv === "Ed25519" && typeof o.x === "string" && /^[A-Za-z0-9_-]{43}$/.test(o.x);
}

const toBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Run the signature check. `ok:false` means the base could not be built (the
 * crypto never ran); `ok:true, value:false` means the crypto ran and said no.
 */
export async function verifySignature(message: SignedMessage, sig: ParsedSignature, jwk: Ed25519Jwk): Promise<Result<boolean>> {
  const base = signatureBase(message, sig.input);
  if (!base.ok) return base;
  return verifyBase(base.value, sig.signature, jwk);
}

export async function verifyBase(base: string, signature: Uint8Array, jwk: Ed25519Jwk): Promise<Result<boolean>> {
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    return okv(await crypto.subtle.verify({ name: "Ed25519" }, key, toBuf(signature), toBuf(new TextEncoder().encode(base))));
  } catch (e) {
    // A malformed key is a resolution problem, not evidence about the signer.
    return err("key_import_failed", (e as Error).message);
  }
}

export { bytesFromBase64, parseItem };
export type { Item };
