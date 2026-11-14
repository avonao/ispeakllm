// Ported from llms-txt/src/policy-set.ts (goplainly-v6-2026-11-10-current-dormant)
//
// ONE entry point: renderPolicySet(declaration) returns every artifact,
// projected from the same resolved scopes so they cannot disagree with each
// other or with the declaration.

import { parseDeclaration, type Declaration } from "./model";
import {
  aiprefValues,
  axisStates,
  contentSignalFromStates,
  contentUsageValue,
  stancesForPath,
} from "./resolve";
import { renderRobots } from "./robots";
import { renderRsl } from "./rsl";
import { renderAiTxt } from "./aitxt";
import { TDMREP_PATH, renderTdmrepJson, tdmReservationHeader } from "./tdm";

export type PolicyHeaders = {
  "Content-Signal"?: string;
  "Content-Usage"?: string;
  "tdm-reservation"?: "0" | "1";
  "tdm-policy"?: string;
};

export type PolicySetOptions = {
  /** `emd_...` id of the declaration, carried in comments. */
  readonly id?: string;
  /** Site origin, default `https://<domain>`. */
  readonly origin?: string;
  /** Path the RSL file is served at; default `/license.xml`. */
  readonly rslPath?: string;
  /** Path the ai.txt file is served at; default `/ai.txt`. */
  readonly aiTxtPath?: string;
  /** Optional URL of a TDM policy document, emitted as `tdm-policy`. */
  readonly tdmPolicyUrl?: string | null;
};

export type PolicyArtifact = {
  /** Where the file is served (robots.txt entry is a block to merge into /robots.txt). */
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
};

export type PolicySet = {
  readonly declaration: Declaration;
  /** Response headers for the domain-wide (root) scope. */
  readonly headers: PolicyHeaders;
  /** Response headers for any path, by the same longest-prefix rule the artifacts use. */
  readonly headersFor: (path: string) => PolicyHeaders;
  /** robots.txt policy block (merge into the site's robots.txt). */
  readonly robotsTxt: string;
  /** RSL 1.0 XML, or null when silent on every RSL term. */
  readonly rslXml: string | null;
  readonly aiTxt: string;
  /** /.well-known/tdmrep.json, or null when silent on training. */
  readonly tdmrepJson: string | null;
  /** Everything above as servable files (null artifacts omitted). */
  readonly artifacts: readonly PolicyArtifact[];
  /** Why something was not (or only partly) projected. */
  readonly notes: readonly string[];
};

/** Response headers for one path (`null` = domain root). Silent axes emit no header. */
export function policyHeaders(decl: Declaration, path: string | null = null, opts: Pick<PolicySetOptions, "tdmPolicyUrl"> = {}): PolicyHeaders {
  const m = stancesForPath(decl, path);
  const h: PolicyHeaders = {};
  const cs = contentSignalFromStates(axisStates(m));
  if (cs) h["Content-Signal"] = cs;
  const cu = contentUsageValue(aiprefValues(m));
  if (cu) h["Content-Usage"] = cu;
  const tdm = tdmReservationHeader(decl, path);
  if (tdm) {
    h["tdm-reservation"] = tdm;
    if (opts.tdmPolicyUrl) h["tdm-policy"] = opts.tdmPolicyUrl;
  }
  return h;
}

/**
 * Render every projection of a declaration. Accepts a validated
 * {@link Declaration} or raw input (validated here; throws `DeclarationError`
 * when invalid).
 */
export function renderPolicySet(input: Declaration | unknown, opts: PolicySetOptions = {}): PolicySet {
  const decl = parseDeclaration(input);
  const origin = (opts.origin ?? `https://${decl.domain}`).replace(/\/+$/, "");
  const rslPath = opts.rslPath ?? "/license.xml";
  const aiTxtPath = opts.aiTxtPath ?? "/ai.txt";
  const idOpt = opts.id ? { id: opts.id } : {};

  const rslXml = renderRsl(decl, { origin });
  const robots = renderRobots(decl, { ...idOpt, rslUrl: rslXml ? `${origin}${rslPath}` : null });
  const aiTxt = renderAiTxt(decl, idOpt);
  const tdmrepJson = renderTdmrepJson(decl, { policyUrl: opts.tdmPolicyUrl ?? null });

  const artifacts: PolicyArtifact[] = [
    { path: "/robots.txt", contentType: "text/plain; charset=utf-8", body: robots.text },
    ...(rslXml ? [{ path: rslPath, contentType: "application/rsl+xml; charset=utf-8", body: rslXml }] : []),
    { path: aiTxtPath, contentType: "text/plain; charset=utf-8", body: aiTxt },
    ...(tdmrepJson ? [{ path: TDMREP_PATH, contentType: "application/json", body: tdmrepJson }] : []),
  ];

  const notes = [...robots.notes];
  if (!rslXml) notes.push("No RSL document: the declaration is silent on every RSL usage term.");
  if (!tdmrepJson) notes.push("No TDM reservation: the declaration is silent on training and evaluation.");

  const tdm = { tdmPolicyUrl: opts.tdmPolicyUrl ?? null };
  return {
    declaration: decl,
    headers: policyHeaders(decl, null, tdm),
    headersFor: (path: string) => policyHeaders(decl, path, tdm),
    robotsTxt: robots.text,
    rslXml,
    aiTxt,
    tdmrepJson,
    artifacts,
    notes,
  };
}
