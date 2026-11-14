/**
 * JSON Canonicalization Scheme (JCS), RFC 8785.
 *
 *  - Object members sorted by UTF-16 code units of the key (JS default string order).
 *  - Numbers serialised as ECMAScript Number::toString (what RFC 8785 section 3.2.2.3 requires);
 *    -0 becomes `0`; NaN and Infinity are rejected.
 *  - Strings use the minimal JSON escaping of JSON.stringify (matches RFC 8785 section 3.2.2.2);
 *    strings with lone surrogates are rejected (I-JSON).
 *  - No whitespace.
 *
 * Only JSON data is accepted: plain objects, arrays, strings, finite numbers, booleans, null.
 * `undefined` object members are omitted (as JSON.stringify does); `undefined` in an array,
 * and any other type (bigint, function, symbol, Date, Map...), throws, because silently
 * dropping data from a signed payload is how signatures lie.
 */

export function canonicalize(value: unknown): string {
  return ser(value, "$");
}

function ser(v: unknown, at: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error(`@ispeakllm/sign: non-finite number at ${at} cannot be canonicalised`);
      return JSON.stringify(v);
    case "string":
      assertWellFormed(v, at);
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return "[" + v.map((x, i) => (x === undefined ? fail(`undefined in array at ${at}[${i}]`) : ser(x, `${at}[${i}]`))).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`@ispeakllm/sign: non-plain object at ${at} cannot be canonicalised`);
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
      return (
        "{" +
        keys
          .map((k) => {
            assertWellFormed(k, `${at} key`);
            return JSON.stringify(k) + ":" + ser(rec[k], `${at}.${k}`);
          })
          .join(",") +
        "}"
      );
    }
    default:
      throw new Error(`@ispeakllm/sign: ${typeof v} at ${at} cannot be canonicalised`);
  }
}

function fail(msg: string): never {
  throw new Error(`@ispeakllm/sign: ${msg}`);
}

function assertWellFormed(s: string, at: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else fail(`lone surrogate in string at ${at}`);
    } else if (c >= 0xdc00 && c <= 0xdfff) fail(`lone surrogate in string at ${at}`);
  }
}

/** UTF-8 bytes of the canonical form. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
