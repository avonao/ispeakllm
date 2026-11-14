// Ported from llms-txt/src/policy-set.ts + tdm-evidence.ts (goplainly-v6-2026-11-10-current-dormant)
//
// TDM reservation (W3C TDMRep): the `tdm-reservation` response header and the
// /.well-known/tdmrep.json file. The reservation follows the ai-train axis:
// `1` (reserved) whenever training or evaluation is denied or conditional,
// `0` only when every declared contributor is allow, nothing when silent.

import type { Declaration } from "./model";
import { scopesOf, stancesForPath, tdmState } from "./resolve";

export const TDMREP_PATH = "/.well-known/tdmrep.json";

export type TdmrepEntry = {
  readonly location: string;
  readonly "tdm-reservation": 0 | 1;
  readonly "tdm-policy"?: string;
};

/** The entries, most specific location first (so first-match and longest-match readers agree). */
export function tdmrepEntries(decl: Declaration, opts: { policyUrl?: string | null } = {}): TdmrepEntry[] {
  const out: Array<{ len: number; e: TdmrepEntry }> = [];
  for (const scope of scopesOf(decl)) {
    const st = tdmState(scope.stances);
    if (st === null) continue;
    const location = `${scope.pattern ?? "/"}*`;
    const e: TdmrepEntry = opts.policyUrl
      ? { location, "tdm-reservation": st, "tdm-policy": opts.policyUrl }
      : { location, "tdm-reservation": st };
    out.push({ len: (scope.pattern ?? "/").length, e });
  }
  return out.sort((a, b) => b.len - a.len || (a.e.location < b.e.location ? -1 : 1)).map((x) => x.e);
}

/** /.well-known/tdmrep.json, or null when the declaration is silent on training everywhere. */
export function renderTdmrepJson(decl: Declaration, opts: { policyUrl?: string | null } = {}): string | null {
  const entries = tdmrepEntries(decl, opts);
  return entries.length === 0 ? null : JSON.stringify(entries, null, 2) + "\n";
}

/** The `tdm-reservation` header value for one path, or null when silent. */
export function tdmReservationHeader(decl: Declaration, path: string | null): "0" | "1" | null {
  const st = tdmState(stancesForPath(decl, path));
  return st === null ? null : st === 1 ? "1" : "0";
}
