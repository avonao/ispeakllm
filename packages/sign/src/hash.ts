import { toBase64Url, toHex, utf8 } from "./encoding";
import { canonicalBytes } from "./jcs";

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

/** SHA-256, lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

export const ID_PREFIX = "ispk_";

/** Content-addressed id of raw bytes: `ispk_` + base64url(SHA-256(bytes)). */
export async function contentIdOfBytes(bytes: string | Uint8Array): Promise<string> {
  return ID_PREFIX + toBase64Url(await sha256(bytes));
}

/** Content-addressed id of a JSON value: `ispk_` + base64url(SHA-256(JCS(value))). */
export async function contentId(value: unknown): Promise<string> {
  return ID_PREFIX + toBase64Url(await sha256(canonicalBytes(value)));
}

export const isContentId = (s: unknown): s is string => typeof s === "string" && /^ispk_[A-Za-z0-9_-]{43}$/.test(s);
