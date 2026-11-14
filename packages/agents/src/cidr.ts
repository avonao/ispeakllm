// Ported from runtime/emissary/src/reverse-dns.ts `expandIpv6`/`normaliseIp` and runtime/llmstxt/src/bots.ts cidr matching
// (trustvice-v3-2026-11-10-current, goplainly-v6-2026-11-10-current-dormant), rewritten with BigInt arithmetic.
//
// IPv4 and IPv6 parsing and CIDR matching. Pure.

export type ParsedIp = { readonly version: 4 | 6; readonly value: bigint };

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null; // ambiguous octal-looking form
    const n = Number(part);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(input: string): bigint | null {
  const s = input.split("%")[0]!; // drop a zone id
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || s.length < 2) return null;
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const bits = part.split(":");
    for (let i = 0; i < bits.length; i++) {
      const g = bits[i]!;
      if (g.includes(".")) {
        if (i !== bits.length - 1) return null;
        const v4 = parseV4(g);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const head = toGroups(dbl[0]!);
  const tail = dbl.length === 2 ? toGroups(dbl[1]!) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

/** Parse an address. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to IPv4. */
export function parseIp(ip: string): ParsedIp | null {
  const s = ip.trim();
  if (s.includes(":")) {
    const v = parseV6(s);
    if (v === null) return null;
    if (v >> 32n === 0xffffn) return { version: 4, value: v & 0xffffffffn };
    return { version: 6, value: v };
  }
  const v4 = parseV4(s);
  return v4 === null ? null : { version: 4, value: v4 };
}

/** Canonical text form: dotted quad, or 32 lower-case hex nibbles for IPv6. */
export function normaliseIp(ip: string): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.version === 4) return [24n, 16n, 8n, 0n].map((sh) => Number((p.value >> sh) & 0xffn)).join(".");
  return p.value.toString(16).padStart(32, "0");
}

export type Cidr = { readonly version: 4 | 6; readonly network: bigint; readonly prefix: number };

/** Parse `a.b.c.d/n` or an IPv6 prefix. A bare address is a host route. Returns null when malformed. */
export function parseCidr(text: string): Cidr | null {
  const [addr, len, extra] = text.trim().split("/");
  if (extra !== undefined || addr === undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const bits = ip.version === 4 ? 32 : 128;
  let prefix = bits;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    prefix = Number(len);
    if (prefix > bits) return null;
  }
  // An IPv4-mapped IPv6 prefix is out of scope: it parsed as IPv4 above, so its length would be off.
  if (addr.includes(":") && ip.version === 4) {
    if (len === undefined) return { version: 4, network: ip.value, prefix: 32 };
    if (prefix < 96) return null;
    prefix -= 96;
  }
  const shift = BigInt(bits - prefix);
  return { version: ip.version, network: (ip.value >> shift) << shift, prefix };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.version !== ip.version) return false;
  const bits = ip.version === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);
  return ip.value >> shift === cidr.network >> shift;
}

/** True when `ip` is inside any of the (text) ranges. Malformed ranges are skipped, a malformed `ip` matches nothing. */
export function ipInAnyCidr(ip: string, ranges: readonly string[]): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  for (const r of ranges) {
    const c = parseCidr(r);
    if (c && cidrContains(c, p)) return true;
  }
  return false;
}

/** Reverse-lookup name for an address (`4.3.2.1.in-addr.arpa`, `...ip6.arpa`). Null when unusable. */
export function toArpaName(ip: string): string | null {
  const p = parseIp(ip);
  if (!p) return null;
  if (p.version === 4) {
    return `${[0n, 8n, 16n, 24n].map((sh) => Number((p.value >> sh) & 0xffn)).join(".")}.in-addr.arpa`;
  }
  return `${p.value.toString(16).padStart(32, "0").split("").reverse().join(".")}.ip6.arpa`;
}
