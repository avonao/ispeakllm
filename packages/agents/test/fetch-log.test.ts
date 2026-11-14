// Ported from contracts/src/fetch-ledger.test.ts (consentrack-v1-2026-10-30-fetch-ledger)
//
// The tests that matter are the ones about ABSENCE and ATTRIBUTION: an empty
// ledger must not read as "nothing changed", and a fetch whose signature failed
// must not read as an ordinary anonymous one.
import { describe, it, expect } from "vitest";
import {
  FETCH_LOG_SCHEMA,
  IDENTITY_GRADES,
  attributedOperator,
  attributionGap,
  detectDrift,
  driftHistory,
  holdersOfStaleVersions,
  isAttributable,
  buildFetchRecord,
  parseFetchLog,
  parseFetchRecord,
  serializeFetchRecord,
  type FetchLogRecord,
} from "../src/index";

const URL_A = "https://site.example/.well-known/llms.txt";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function rec(over: Partial<FetchLogRecord> = {}): FetchLogRecord {
  return {
    schema: FETCH_LOG_SCHEMA,
    fetchId: "f_1",
    url: URL_A,
    contentSha256: H1,
    fetchedAtIso: "2026-06-01T00:00:00.000Z",
    grade: "verified",
    operator: "openai",
    ...over,
  };
}

describe("identity: not signing and signing badly are different events", () => {
  it("has four states, not a boolean", () => {
    expect(IDENTITY_GRADES).toEqual(["verified", "failed", "unauthenticated", "unchecked"]);
  });

  it("only a verified identity is attributable", () => {
    expect(isAttributable("verified")).toBe(true);
    for (const s of ["failed", "unauthenticated", "unchecked"] as const) expect(isAttributable(s)).toBe(false);
  });

  it("refuses to attribute a FAILED signature, even when an operator was stamped", () => {
    // The dangerous case: a forged claim reading as an ordinary anonymous fetch,
    // or worse, as the operator it named.
    expect(attributedOperator(rec({ grade: "failed", operator: "openai" }))).toBeNull();
  });

  it("refuses to attribute an UNCHECKED one — not a pass and not a failure", () => {
    expect(attributedOperator(rec({ grade: "unchecked", operator: "openai" }))).toBeNull();
  });

  it("attributes a verified one", () => {
    expect(attributedOperator(rec())).toBe("openai");
  });

  it("treats a verified record with a blank operator as unattributed", () => {
    expect(attributedOperator(rec({ operator: "   " }))).toBeNull();
    expect(attributedOperator(rec({ operator: null }))).toBeNull();
  });
});

describe("drift", () => {
  it("an empty ledger is 'no-record', NOT 'unchanged'", () => {
    const d = detectDrift(URL_A, [], H1);
    expect(d.status).toBe("no-record");
    // Said in words, because this is where a reader supplies the reassuring reading.
    if (d.status === "no-record") expect(d.message).toContain("not the same as nothing having changed");
  });

  it("reports unchanged when the current bytes hash to what was served", () => {
    expect(detectDrift(URL_A, [rec()], H1).status).toBe("unchanged");
  });

  it("reports changed with BOTH digests and judges nothing", () => {
    const d = detectDrift(URL_A, [rec()], H2);
    expect(d.status).toBe("changed");
    if (d.status === "changed") {
      expect(d.servedSha256).toBe(H1);
      expect(d.currentSha256).toBe(H2);
      // No severity, no verdict: the hash cannot support one.
      expect(d).not.toHaveProperty("severity");
      expect(Object.keys(d).sort()).toEqual(["currentSha256", "fetchedAtIso", "servedSha256", "status", "url"]);
    }
  });

  it("a resource that is gone is 'withdrawn', not 'changed'", () => {
    const d = detectDrift(URL_A, [rec()], null);
    expect(d.status).toBe("withdrawn");
  });

  it("compares against the LATEST fetch, because that claim is the live one", () => {
    const older = rec({ fetchId: "old", contentSha256: H1, fetchedAtIso: "2026-01-01T00:00:00.000Z" });
    const newer = rec({ fetchId: "new", contentSha256: H2, fetchedAtIso: "2026-07-01T00:00:00.000Z" });
    expect(detectDrift(URL_A, [older, newer], H2).status).toBe("unchanged");
    expect(detectDrift(URL_A, [newer, older], H2).status).toBe("unchanged"); // order-independent
  });

  it("a malformed timestamp sorts oldest and cannot become 'the latest'", () => {
    const good = rec({ fetchId: "good", contentSha256: H2, fetchedAtIso: "2026-07-01T00:00:00.000Z" });
    const broken = rec({ fetchId: "broken", contentSha256: H1, fetchedAtIso: "whenever" });
    expect(detectDrift(URL_A, [good, broken], H2).status).toBe("unchanged");
  });

  it("ignores records for other urls", () => {
    const other = rec({ url: "https://elsewhere.example/x", contentSha256: H2 });
    expect(detectDrift(URL_A, [other], H1).status).toBe("no-record");
  });
});

describe("history", () => {
  it("counts distinct versions, oldest first, with fetch counts", () => {
    const h = driftHistory(URL_A, [
      rec({ fetchId: "1", contentSha256: H1, fetchedAtIso: "2026-01-01T00:00:00.000Z" }),
      rec({ fetchId: "2", contentSha256: H1, fetchedAtIso: "2026-02-01T00:00:00.000Z" }),
      rec({ fetchId: "3", contentSha256: H2, fetchedAtIso: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(h).toHaveLength(2);
    expect(h[0]?.sha256).toBe(H1);
    expect(h[0]?.fetches).toBe(2);
    expect(h[0]?.firstSeenIso).toBe("2026-01-01T00:00:00.000Z");
    expect(h[1]?.sha256).toBe(H2);
  });

  it("is empty for a url nobody fetched", () => {
    expect(driftHistory("https://nope.example/x", [rec()])).toEqual([]);
  });
});

describe("who is still holding an old version", () => {
  it("returns verified holders of a stale version", () => {
    const stale = rec({ fetchId: "s", operator: "anthropic", contentSha256: H1, fetchedAtIso: "2026-05-01T00:00:00.000Z" });
    const current = rec({ fetchId: "c", operator: "openai", contentSha256: H2 });
    const holders = holdersOfStaleVersions(URL_A, [stale, current], H2);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.operator).toBe("anthropic");
  });

  it("omits clients that cannot be attributed — a user agent is not a recipient", () => {
    const anon = rec({ fetchId: "a", grade: "unauthenticated", operator: null, userAgent: "SomeBot/1.0", contentSha256: H1 });
    expect(holdersOfStaleVersions(URL_A, [anon], H2)).toEqual([]);
  });

  it("keeps the most recent stale fetch per operator", () => {
    const old1 = rec({ fetchId: "1", operator: "anthropic", contentSha256: H1, fetchedAtIso: "2026-01-01T00:00:00.000Z" });
    const old2 = rec({ fetchId: "2", operator: "anthropic", contentSha256: H1, fetchedAtIso: "2026-05-01T00:00:00.000Z" });
    const holders = holdersOfStaleVersions(URL_A, [old1, old2], H2);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.fetchedAtIso).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("the attribution gap is published beside the attributed figure", () => {
  it("counts every state, so 'we notified everyone' can be checked", () => {
    const gap = attributionGap([
      rec({ grade: "verified" }),
      rec({ grade: "failed" }),
      rec({ grade: "unauthenticated" }),
      rec({ grade: "unauthenticated" }),
      rec({ grade: "unchecked" }),
    ]);
    expect(gap).toEqual({ verified: 1, failed: 1, unauthenticated: 2, unchecked: 1 });
  });

  it("is all zeroes for an empty ledger rather than throwing", () => {
    expect(attributionGap([])).toEqual({ verified: 0, failed: 0, unauthenticated: 0, unchecked: 0 });
  });
});

describe("the local log format", () => {
  const ident = {
    grade: "unauthenticated", code: "unsigned", reason: "r", network: "claimed", networkNote: "n",
    claimedAgent: "gptbot", operator: null, keyid: null, signatureAgent: null, contradiction: false,
  } as const;
  const input = { fetchId: "f1", url: URL_A, contentSha256: H1, fetchedAtIso: "2026-06-01T00:00:00.000Z", identity: ident, userAgent: "GPTBot/1.0", ip: "203.0.113.9", ipSalt: "a-long-enough-secret-salt" };

  it("hashes the address: the raw IP appears nowhere in the line", async () => {
    const r = await buildFetchRecord(input);
    const line = serializeFetchRecord(r);
    expect(line).not.toContain("203.0.113.9");
    expect(r.ipHash).toMatch(/^ip1_[0-9a-f]{32}$/);
    expect(line).not.toContain("\n");
  });

  it("never stamps an operator on an unverified record", async () => {
    const r = await buildFetchRecord({ ...input, identity: { ...ident, operator: "OpenAI" } });
    expect(r.operator).toBeNull();
  });

  it("round-trips and has stable bytes", async () => {
    const r = await buildFetchRecord(input);
    const line = serializeFetchRecord(r);
    expect(serializeFetchRecord(r)).toBe(line);
    const p = parseFetchRecord(line);
    expect(p.ok && p.record).toEqual(JSON.parse(line));
  });

  it("rejects a record that carries a raw address, a bad grade or a bad hash", () => {
    const base = { schema: FETCH_LOG_SCHEMA, fetchId: "f", url: URL_A, contentSha256: H1, fetchedAtIso: "2026-06-01T00:00:00.000Z", grade: "verified" };
    expect(parseFetchRecord(JSON.stringify({ ...base, ip: "203.0.113.9" }))).toMatchObject({ ok: false, code: "raw_ip_present" });
    expect(parseFetchRecord(JSON.stringify({ ...base, grade: "trusted" }))).toMatchObject({ ok: false, code: "bad_grade" });
    expect(parseFetchRecord(JSON.stringify({ ...base, ipHash: "203.0.113.9" }))).toMatchObject({ ok: false, code: "bad_ip_hash" });
    expect(parseFetchRecord("not json")).toMatchObject({ ok: false, code: "not_json" });
  });

  it("reports bad lines by number instead of dropping them", async () => {
    const good = serializeFetchRecord(await buildFetchRecord(input));
    const log = parseFetchLog(`${good}\n\nnot json\n${good}\n`);
    expect(log.records).toHaveLength(2);
    expect(log.errors).toEqual([{ line: 3, code: "not_json", message: "The line is not JSON." }]);
  });
});
