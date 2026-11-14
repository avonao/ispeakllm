// New for IspeakLLM (RFC 8941 Structured Field Values, the subset RFC 9421 needs).
// Replaces the narrow hand-parsers in trustvice-v3 web-bot-auth.ts and
// goplainly-v6 webbotauth.ts with one strict parser. It rejects anything it
// does not understand: a parser that guesses turns an unknown shape into a
// confident verdict.

export class SfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfError";
  }
}

export type BareItem =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "token"; readonly value: string }
  | { readonly type: "integer"; readonly value: number }
  | { readonly type: "decimal"; readonly value: number }
  | { readonly type: "bytes"; readonly value: Uint8Array }
  | { readonly type: "boolean"; readonly value: boolean };

export type Params = ReadonlyArray<readonly [string, BareItem]>;
export type Item = { readonly value: BareItem; readonly params: Params };
export type InnerList = { readonly members: readonly Item[]; readonly params: Params };
/** One dictionary member. `raw` is the member's value text exactly as it appeared. */
export type DictMember = { readonly key: string; readonly value: Item | InnerList; readonly raw: string };

export const isInnerList = (v: Item | InnerList): v is InnerList => "members" in v;

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/-/g, "+").replace(/_/g, "/");
  if (!B64.test(clean)) throw new SfError("invalid base64");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  peek(): string {
    return this.s[this.i] ?? "";
  }
  skipSp(): void {
    while (this.s[this.i] === " ") this.i++;
  }
  skipOws(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }
}

function parseKey(c: Cursor): string {
  if (!KEY_START.test(c.peek())) throw new SfError("bad key");
  const start = c.i;
  while (!c.done && KEY_CHAR.test(c.peek())) c.i++;
  return c.s.slice(start, c.i);
}

function parseBareItem(c: Cursor): BareItem {
  const ch = c.peek();
  if (ch === '"') {
    c.i++;
    let out = "";
    for (;;) {
      if (c.done) throw new SfError("unterminated string");
      const x = c.s[c.i++]!;
      if (x === "\\") {
        const n = c.s[c.i++];
        if (n !== '"' && n !== "\\") throw new SfError("bad escape");
        out += n;
      } else if (x === '"') return { type: "string", value: out };
      else if (x.charCodeAt(0) < 0x20 || x.charCodeAt(0) > 0x7e) throw new SfError("bad string char");
      else out += x;
    }
  }
  if (ch === ":") {
    c.i++;
    const end = c.s.indexOf(":", c.i);
    if (end < 0) throw new SfError("unterminated byte sequence");
    const b64 = c.s.slice(c.i, end);
    c.i = end + 1;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new SfError("bad byte sequence");
    return { type: "bytes", value: bytesFromBase64(b64) };
  }
  if (ch === "?") {
    c.i++;
    const v = c.s[c.i++];
    if (v !== "0" && v !== "1") throw new SfError("bad boolean");
    return { type: "boolean", value: v === "1" };
  }
  if (ch === "-" || (ch >= "0" && ch <= "9")) {
    const start = c.i;
    if (ch === "-") c.i++;
    let digits = 0;
    let decimal = false;
    while (!c.done) {
      const x = c.peek();
      if (x >= "0" && x <= "9") digits++;
      else if (x === "." && !decimal) decimal = true;
      else break;
      c.i++;
    }
    const text = c.s.slice(start, c.i);
    if (digits === 0 || digits > 15 || text.endsWith(".")) throw new SfError("bad number");
    if (decimal && text.split(".")[1]!.length > 3) throw new SfError("bad decimal");
    return decimal ? { type: "decimal", value: Number(text) } : { type: "integer", value: Number(text) };
  }
  if (/[A-Za-z*]/.test(ch)) {
    const start = c.i;
    while (!c.done && (TCHAR.test(c.peek()) || c.peek() === ":" || c.peek() === "/")) c.i++;
    return { type: "token", value: c.s.slice(start, c.i) };
  }
  throw new SfError("unrecognised item");
}

function parseParams(c: Cursor): Params {
  const out: Array<readonly [string, BareItem]> = [];
  while (c.peek() === ";") {
    c.i++;
    c.skipSp();
    const key = parseKey(c);
    let value: BareItem = { type: "boolean", value: true };
    if (c.peek() === "=") {
      c.i++;
      value = parseBareItem(c);
    }
    const existing = out.findIndex(([k]) => k === key);
    if (existing >= 0) out[existing] = [key, value];
    else out.push([key, value]);
  }
  return out;
}

function parseItemOrInner(c: Cursor): Item | InnerList {
  if (c.peek() === "(") {
    c.i++;
    const members: Item[] = [];
    for (;;) {
      c.skipSp();
      if (c.peek() === ")") {
        c.i++;
        return { members, params: parseParams(c) };
      }
      if (c.done) throw new SfError("unterminated inner list");
      const value = parseBareItem(c);
      members.push({ value, params: parseParams(c) });
      if (c.peek() !== " " && c.peek() !== ")") throw new SfError("bad inner list separator");
    }
  }
  const value = parseBareItem(c);
  return { value, params: parseParams(c) };
}

/** Parse a Structured Field dictionary. Throws {@link SfError}. */
export function parseDictionary(input: string): DictMember[] {
  const c = new Cursor(input);
  const out: DictMember[] = [];
  c.skipSp();
  if (c.done) return out;
  for (;;) {
    const key = parseKey(c);
    let value: Item | InnerList;
    if (c.peek() === "=") c.i++;
    const hasValue = c.s[c.i - 1] === "=";
    const start = c.i;
    value = hasValue ? parseItemOrInner(c) : { value: { type: "boolean", value: true }, params: parseParams(c) };
    const member: DictMember = { key, value, raw: c.s.slice(start, c.i) };
    const existing = out.findIndex((m) => m.key === key);
    if (existing >= 0) out[existing] = member;
    else out.push(member);
    c.skipOws();
    if (c.done) return out;
    if (c.peek() !== ",") throw new SfError("expected comma");
    c.i++;
    c.skipOws();
    if (c.done) throw new SfError("trailing comma");
  }
}

/** Parse a single Structured Field item (e.g. `"https://chatgpt.com"`). Throws {@link SfError}. */
export function parseItem(input: string): Item {
  const c = new Cursor(input);
  c.skipSp();
  const v = parseItemOrInner(c);
  c.skipSp();
  if (!c.done || isInnerList(v)) throw new SfError("not a single item");
  return v;
}

/* ── Serialisation (RFC 8941 section 4) ─────────────────────────────── */

export function serializeBareItem(b: BareItem): string {
  switch (b.type) {
    case "string":
      return `"${b.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    case "token":
      return b.value;
    case "integer":
      return String(b.value);
    case "decimal":
      throw new SfError("decimal serialisation is not supported");
    case "bytes":
      return `:${base64FromBytes(b.value)}:`;
    case "boolean":
      return b.value ? "?1" : "?0";
  }
}

export function serializeParams(p: Params): string {
  return p
    .map(([k, v]) => (v.type === "boolean" && v.value ? `;${k}` : `;${k}=${serializeBareItem(v)}`))
    .join("");
}

export function serializeItem(i: Item): string {
  return serializeBareItem(i.value) + serializeParams(i.params);
}

export function serializeInnerList(l: InnerList): string {
  return `(${l.members.map(serializeItem).join(" ")})${serializeParams(l.params)}`;
}

export function paramOf(p: Params, key: string): BareItem | undefined {
  return p.find(([k]) => k === key)?.[1];
}
