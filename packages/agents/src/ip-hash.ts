// New for iSpeakLLM. The raw client IP is never stored: the local fetch log
// keeps only a salted keyed hash, enough to count "the same client again"
// within one salt epoch and nothing more.

import { normaliseIp } from "./cidr";

const MIN_SALT_LENGTH = 16;

/**
 * `ip1_` + the first 128 bits (hex) of HMAC-SHA256(salt, normalised ip).
 * Returns null for an unparseable address (store nothing rather than the raw text).
 * Rotate the salt to break linkability across periods.
 */
export async function saltedIpHash(ip: string | null | undefined, salt: string): Promise<string | null> {
  if (salt.length < MIN_SALT_LENGTH) throw new RangeError(`salt must be at least ${MIN_SALT_LENGTH} characters`);
  if (!ip) return null;
  const n = normaliseIp(ip);
  if (n === null) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(n)));
  let hex = "";
  for (const b of mac.subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `ip1_${hex}`;
}
