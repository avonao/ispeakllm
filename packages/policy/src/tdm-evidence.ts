// Ported from llms-txt/src/tdm-evidence.ts + runtime/llmstxt/src/tdm-evidence.ts (goplainly-v6-2026-11-10-current-dormant)
//
// TDM opt-out evidence, simplified to a pure function. A rightsholder who
// reserved text-and-data-mining rights eventually has to answer one narrow
// question: WAS the reservation being served, in which formats, at which
// versions, over which period? This answers exactly that and nothing wider.
//
// What it does NOT do, encoded in the shape:
//  - it makes no claim about whether anyone trained on or mined the content;
//  - publish coverage and delivery evidence are SEPARATE (published is not
//    the same fact as handed to someone);
//  - a period with no version in effect is a GAP, never smoothed over;
//  - a version whose body could not be read has reservation `unknown`;
//  - fetches that contradict continuous service (an error status) are carried
//    in the result, not filtered out.
// Signing is out of scope here: hand the result to @ispeakllm/sign.

export type TdmFormat = "content-signal" | "robots-txt" | "aipref" | "rsl" | "ai-txt" | "tdmrep" | "declaration";
export type TdmReservationState = "reserved" | "permitted" | "conditional" | "not-stated" | "unknown";

export type ServedVersion = {
  readonly format: TdmFormat;
  readonly version: string;
  readonly contentHash: string;
  /** ISO timestamp this version went into effect. */
  readonly from: string;
  /** ISO timestamp it stopped, or null while still current. */
  readonly to: string | null;
  readonly reservation: TdmReservationState;
};

export type DeliveryEvent = {
  readonly id: string;
  readonly format: TdmFormat;
  readonly at: string;
  readonly status: number | null;
  /** Identity grade recorded for the requester (`verified`, `failed`, `unauthenticated`, `unchecked`). */
  readonly grade?: string;
  readonly claimedAgent?: string | null;
};

export type TdmEvidenceInput = {
  readonly domain: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly versions: readonly ServedVersion[];
  readonly deliveries?: readonly DeliveryEvent[];
  readonly nowIso: string;
};

export type CoverageInterval = {
  readonly format: TdmFormat;
  readonly version: string;
  readonly contentHash: string;
  readonly from: string;
  /** null = still in effect at the window end. */
  readonly to: string | null;
  readonly reservation: TdmReservationState;
};

export type CoverageGap = { readonly format: TdmFormat; readonly from: string; readonly to: string; readonly reason: string };

export type ServedSummary = {
  readonly format: TdmFormat;
  readonly delivered: number;
  readonly firstAt?: string;
  readonly lastAt?: string;
  readonly byGrade: Readonly<Record<string, number>>;
};

export type TdmEvidence = {
  readonly kind: "tdm-opt-out-evidence";
  readonly domain: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly claimBoundary: string;
  readonly coverage: readonly CoverageInterval[];
  readonly gaps: readonly CoverageGap[];
  readonly served: readonly ServedSummary[];
  readonly contradictingFetches: ReadonlyArray<{ readonly id: string; readonly format: TdmFormat; readonly status: number | null; readonly at: string; readonly reason: string }>;
  readonly formatsNeverPublished: readonly TdmFormat[];
  readonly generatedAt: string;
};

export const TDM_CLAIM_BOUNDARY =
  "This record states which policy formats were published, at which versions and over which period, and which of them were delivered to a requester. It makes no claim about whether any third party trained on, mined or otherwise used the content.";

const FORMATS: readonly TdmFormat[] = ["declaration", "content-signal", "robots-txt", "aipref", "rsl", "ai-txt", "tdmrep"];

const t = (s: string): number => Date.parse(s);

export function buildTdmEvidence(input: TdmEvidenceInput): TdmEvidence {
  const wFrom = t(input.window.from);
  const wTo = t(input.window.to);
  if (!Number.isFinite(wFrom) || !Number.isFinite(wTo) || wFrom >= wTo) {
    throw new RangeError("window must be a valid interval with from < to");
  }

  const coverage: CoverageInterval[] = [];
  const gaps: CoverageGap[] = [];
  const never: TdmFormat[] = [];

  for (const format of FORMATS) {
    const vs = input.versions.filter((v) => v.format === format && t(v.from) <= wTo);
    if (vs.length === 0) {
      never.push(format);
      continue;
    }
    const spans: Array<[number, number]> = [];
    for (const v of vs.sort((a, b) => t(a.from) - t(b.from))) {
      const from = Math.max(t(v.from), wFrom);
      const toRaw = v.to === null ? Number.POSITIVE_INFINITY : t(v.to);
      const to = Math.min(toRaw, wTo);
      if (to <= from) continue;
      spans.push([from, to]);
      coverage.push({
        format,
        version: v.version,
        contentHash: v.contentHash,
        from: new Date(from).toISOString(),
        to: toRaw >= wTo ? null : new Date(to).toISOString(),
        reservation: v.reservation,
      });
    }
    // Gaps: parts of the window no version covers.
    let cursor = wFrom;
    for (const [s, e] of spans.sort((a, b) => a[0] - b[0])) {
      if (s > cursor) {
        gaps.push({ format, from: new Date(cursor).toISOString(), to: new Date(s).toISOString(), reason: "No version of this format was in effect." });
      }
      cursor = Math.max(cursor, e);
    }
    if (cursor < wTo) {
      gaps.push({ format, from: new Date(cursor).toISOString(), to: new Date(wTo).toISOString(), reason: "No version of this format was in effect." });
    }
    if (spans.length === 0) never.push(format);
  }

  const served: ServedSummary[] = [];
  const contradicting: Array<{ id: string; format: TdmFormat; status: number | null; at: string; reason: string }> = [];
  for (const format of FORMATS) {
    const ds = (input.deliveries ?? []).filter((d) => d.format === format && t(d.at) >= wFrom && t(d.at) <= wTo);
    const ok = ds.filter((d) => d.status !== null && ((d.status >= 200 && d.status < 300) || d.status === 304));
    for (const d of ds) {
      if (d.status === null || d.status >= 400) {
        contradicting.push({ id: d.id, format, status: d.status, at: d.at, reason: "A recorded fetch of a published policy artifact did not succeed." });
      }
    }
    if (ok.length === 0) continue;
    const byGrade: Record<string, number> = {};
    for (const d of ok) byGrade[d.grade ?? "unchecked"] = (byGrade[d.grade ?? "unchecked"] ?? 0) + 1;
    const times = ok.map((d) => t(d.at)).sort((a, b) => a - b);
    served.push({
      format,
      delivered: ok.length,
      firstAt: new Date(times[0]!).toISOString(),
      lastAt: new Date(times[times.length - 1]!).toISOString(),
      byGrade: Object.fromEntries(Object.entries(byGrade).sort(([a], [b]) => (a < b ? -1 : 1))),
    });
  }
  contradicting.sort((a, b) => t(a.at) - t(b.at) || (a.id < b.id ? -1 : 1));

  return {
    kind: "tdm-opt-out-evidence",
    domain: input.domain.toLowerCase(),
    window: { from: new Date(wFrom).toISOString(), to: new Date(wTo).toISOString() },
    claimBoundary: TDM_CLAIM_BOUNDARY,
    coverage,
    gaps,
    served,
    contradictingFetches: contradicting,
    formatsNeverPublished: never,
    generatedAt: input.nowIso,
  };
}

/** Reservation state from a TDM state (`1` reserved, `0` not, null silent). */
export function reservationFromTdm(v: 0 | 1 | null): TdmReservationState {
  return v === 1 ? "reserved" : v === 0 ? "permitted" : "not-stated";
}
