// Ported from contracts/src/fetch-ledger.ts + fetch-ledger.test.ts (consentrack-v1-2026-10-30-fetch-ledger)
//
// The local fetch log: what an agent was served, and whether it still holds.
//
// DRIFT IS REPORTED, NOT JUDGED. A content hash proves that something changed.
// It does not say what changed, whether it mattered, or which version is
// correct. `detectDrift` returns `changed` with BOTH digests and nothing else;
// there is no severity field and there must not be one.
//
// ABSENCE IS A STATE, NOT AN ABSENCE OF DRIFT. "No record of that fetch" and
// "nothing has changed since that fetch" are different findings: `no-record`
// versus `unchanged`.
//
// AN UNVERIFIED BOT IS NOT AN ANONYMOUS ONE. Not signing (`unauthenticated`)
// and signing badly (`failed`) are different events; only a `verified`
// identity can be attributed to an operator or notified.
//
// The raw client IP is never stored: only a salted keyed hash (ip-hash.ts).

import type { Identity, NetworkEvidence } from "./grade";
import { NETWORK_EVIDENCE } from "./grade";
import { saltedIpHash } from "./ip-hash";
import { IDENTITY_GRADES, type IdentityGrade } from "./web-bot-auth";

export const FETCH_LOG_SCHEMA = "ispeakllm.fetch/1" as const;

export type FetchLogRecord = {
  readonly schema: typeof FETCH_LOG_SCHEMA;
  readonly fetchId: string;
  /** The resource served, absolute. */
  readonly url: string;
  /** SHA-256 hex of exactly the bytes served. */
  readonly contentSha256: string;
  readonly fetchedAtIso: string;
  readonly status?: number | null;
  readonly grade: IdentityGrade;
  readonly network?: NetworkEvidence;
  /** Stable code explaining the grade. */
  readonly code?: string | null;
  /** Present ONLY when `grade` is `verified`; `attributedOperator` enforces it on read. */
  readonly operator?: string | null;
  /** The registry id the User-Agent claimed. A claim, never attribution. */
  readonly claimedAgent?: string | null;
  readonly userAgent?: string | null;
  readonly keyid?: string | null;
  /** `ip1_` + salted keyed hash. Never the address. */
  readonly ipHash?: string | null;
};

/** Only a positively verified identity may be attributed to a named operator. */
export function isAttributable(grade: IdentityGrade): boolean {
  return grade === "verified";
}

/**
 * The operator a record may be attributed to. Null for anything but a verified
 * identity, even when the record carries an `operator` string: a writer that
 * stamps an operator beside an unverified request has recorded a guess, and
 * reading it back as fact is how the guess becomes evidence.
 */
export function attributedOperator(record: FetchLogRecord | null | undefined): string | null {
  if (!record || !isAttributable(record.grade)) return null;
  const op = record.operator;
  return op && String(op).trim() ? op : null;
}

/* ── Building, serialising, parsing ─────────────────────────────────── */

const MAX_UA = 256;

export type BuildFetchRecordInput = {
  readonly fetchId: string;
  readonly url: string;
  readonly contentSha256: string;
  readonly fetchedAtIso: string;
  readonly status?: number | null;
  readonly identity: Identity;
  readonly userAgent?: string | null;
  /** The source address; hashed and discarded. */
  readonly ip?: string | null;
  /** Secret salt, at least 16 characters. */
  readonly ipSalt: string;
};

export async function buildFetchRecord(input: BuildFetchRecordInput): Promise<FetchLogRecord> {
  const { identity } = input;
  return {
    schema: FETCH_LOG_SCHEMA,
    fetchId: input.fetchId,
    url: input.url,
    contentSha256: input.contentSha256,
    fetchedAtIso: input.fetchedAtIso,
    status: input.status ?? null,
    grade: identity.grade,
    network: identity.network,
    code: identity.code,
    operator: identity.grade === "verified" ? identity.operator : null,
    claimedAgent: identity.claimedAgent,
    userAgent: input.userAgent ? input.userAgent.slice(0, MAX_UA) : null,
    keyid: identity.keyid,
    ipHash: await saltedIpHash(input.ip, input.ipSalt),
  };
}

const KEY_ORDER = ["schema", "fetchId", "url", "contentSha256", "fetchedAtIso", "status", "grade", "network", "code", "operator", "claimedAgent", "userAgent", "keyid", "ipHash"] as const;

/** One NDJSON line with a fixed key order (stable bytes for the same record). */
export function serializeFetchRecord(r: FetchLogRecord): string {
  const o: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (r[k] !== undefined) o[k] = r[k];
  return JSON.stringify(o);
}

const RAW_IP_KEYS = ["ip", "ipAddress", "ip_address", "clientIp", "client_ip", "remoteAddr", "remote_addr", "remoteAddress", "cf-connecting-ip", "x-forwarded-for"];

export type ParseResult = { readonly ok: true; readonly record: FetchLogRecord } | { readonly ok: false; readonly code: string; readonly message: string };

/** Parse and validate one log line. A record carrying a raw IP field is rejected, not scrubbed. */
export function parseFetchRecord(line: string): ParseResult {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { ok: false, code: "not_json", message: "The line is not JSON." };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, code: "not_object", message: "The line is not an object." };
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (RAW_IP_KEYS.includes(k.toLowerCase())) return { ok: false, code: "raw_ip_present", message: `Field "${k}" would store a raw address. Store ipHash instead.` };
  }
  if (r.schema !== FETCH_LOG_SCHEMA) return { ok: false, code: "bad_schema", message: `Expected schema ${FETCH_LOG_SCHEMA}.` };
  for (const k of ["fetchId", "url", "contentSha256", "fetchedAtIso"] as const) {
    if (typeof r[k] !== "string" || r[k] === "") return { ok: false, code: "bad_field", message: `${k} must be a non-empty string.` };
  }
  if (!(IDENTITY_GRADES as readonly string[]).includes(r.grade as string)) return { ok: false, code: "bad_grade", message: "grade must be verified, failed, unauthenticated or unchecked." };
  if (r.network !== undefined && !(NETWORK_EVIDENCE as readonly string[]).includes(r.network as string)) return { ok: false, code: "bad_network", message: "Unknown network evidence level." };
  if (r.ipHash !== undefined && r.ipHash !== null && !/^ip1_[0-9a-f]{32}$/.test(String(r.ipHash))) return { ok: false, code: "bad_ip_hash", message: "ipHash must be ip1_ plus 32 hex characters." };
  return { ok: true, record: r as unknown as FetchLogRecord };
}

/** Parse an NDJSON log; bad lines are reported with their line number, not dropped silently. */
export function parseFetchLog(text: string): { records: FetchLogRecord[]; errors: Array<{ line: number; code: string; message: string }> } {
  const records: FetchLogRecord[] = [];
  const errors: Array<{ line: number; code: string; message: string }> = [];
  text.split("\n").forEach((l, i) => {
    if (l.trim() === "") return;
    const p = parseFetchRecord(l);
    if (p.ok) records.push(p.record);
    else errors.push({ line: i + 1, code: p.code, message: p.message });
  });
  return { records, errors };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Drift
 * ══════════════════════════════════════════════════════════════════════════ */

export type DriftFinding =
  /** The bytes served now hash to what this client was served. */
  | { readonly status: "unchanged"; readonly url: string; readonly sha256: string; readonly fetchedAtIso: string }
  /** They do not. Both digests are returned; nothing more is said. */
  | { readonly status: "changed"; readonly url: string; readonly servedSha256: string; readonly currentSha256: string; readonly fetchedAtIso: string }
  /** The resource is no longer published at all. */
  | { readonly status: "withdrawn"; readonly url: string; readonly servedSha256: string; readonly fetchedAtIso: string }
  /** No fetch of this url was ever recorded. NOT "no drift". */
  | { readonly status: "no-record"; readonly url: string; readonly message: string };

/**
 * Compare what a client was served against what is published now. A
 * `currentSha256` of null means the resource is gone: `withdrawn`, not a change.
 * With several fetches of one url, the LATEST is compared (its claim is live).
 */
export function detectDrift(url: string, records: readonly FetchLogRecord[], currentSha256: string | null): DriftFinding {
  const forUrl = (records ?? []).filter((r) => r && r.url === url);
  if (forUrl.length === 0) {
    return {
      status: "no-record",
      url,
      // Said in words, because an empty result is exactly where a reader supplies the reassuring reading.
      message: `No fetch of ${url} was recorded. That is not the same as nothing having changed.`,
    };
  }
  // Latest by fetch time; an unparseable timestamp sorts oldest rather than
  // being dropped, so a malformed row cannot silently become "the latest".
  const time = (r: FetchLogRecord): number => {
    const t = Date.parse(r.fetchedAtIso);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  const latest = [...forUrl].sort((a, b) => time(a) - time(b))[forUrl.length - 1]!;

  if (currentSha256 === null || currentSha256 === undefined) {
    return { status: "withdrawn", url, servedSha256: latest.contentSha256, fetchedAtIso: latest.fetchedAtIso };
  }
  if (currentSha256 === latest.contentSha256) {
    return { status: "unchanged", url, sha256: currentSha256, fetchedAtIso: latest.fetchedAtIso };
  }
  return { status: "changed", url, servedSha256: latest.contentSha256, currentSha256, fetchedAtIso: latest.fetchedAtIso };
}

/** Every distinct version this url was served as, oldest first, with fetch counts. */
export function driftHistory(url: string, records: readonly FetchLogRecord[]): Array<{ sha256: string; firstSeenIso: string; fetches: number }> {
  const byHash = new Map<string, { sha256: string; firstSeenIso: string; fetches: number }>();
  for (const r of (records ?? []).filter((x) => x && x.url === url)) {
    const seen = byHash.get(r.contentSha256);
    if (!seen) {
      byHash.set(r.contentSha256, { sha256: r.contentSha256, firstSeenIso: r.fetchedAtIso, fetches: 1 });
      continue;
    }
    const earlier = Date.parse(r.fetchedAtIso) < Date.parse(seen.firstSeenIso);
    byHash.set(r.contentSha256, { ...seen, fetches: seen.fetches + 1, firstSeenIso: earlier ? r.fetchedAtIso : seen.firstSeenIso });
  }
  return [...byHash.values()].sort((a, b) => Date.parse(a.firstSeenIso) - Date.parse(b.firstSeenIso));
}

/**
 * Which clients were served a version that is no longer current. Only
 * VERIFIED identities are returned: the rest cannot be attributed to anyone to
 * notify, and guessing from a user-agent string would be inventing a recipient.
 */
export function holdersOfStaleVersions(
  url: string,
  records: readonly FetchLogRecord[],
  currentSha256: string,
): Array<{ operator: string; servedSha256: string; fetchedAtIso: string }> {
  const out = new Map<string, { operator: string; servedSha256: string; fetchedAtIso: string }>();
  for (const r of (records ?? []).filter((x) => x && x.url === url && x.contentSha256 !== currentSha256)) {
    const operator = attributedOperator(r);
    if (!operator) continue;
    const prev = out.get(operator);
    // Keep the most recent stale fetch per operator: the version they most likely still hold.
    if (!prev || Date.parse(r.fetchedAtIso) > Date.parse(prev.fetchedAtIso)) {
      out.set(operator, { operator, servedSha256: r.contentSha256, fetchedAtIso: r.fetchedAtIso });
    }
  }
  return [...out.values()].sort((a, b) => a.operator.localeCompare(b.operator));
}

/**
 * How many fetches could not be attributed, by grade. Publish it beside any
 * attributed figure: "we notified everyone who fetched it" is only true of the
 * verified ones, and the count of the rest is the size of what it leaves out.
 */
export function attributionGap(records: readonly FetchLogRecord[]): Record<IdentityGrade, number> {
  const out: Record<IdentityGrade, number> = { verified: 0, failed: 0, unauthenticated: 0, unchecked: 0 };
  for (const r of records ?? []) {
    if (r && r.grade in out) out[r.grade]++;
  }
  return out;
}
