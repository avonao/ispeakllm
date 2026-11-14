// New for IspeakLLM. `ai.txt` is a plain-text statement of the declaration, one
// section per scope. There is no ratified standard for the file; this is a
// readable summary in the same family as robots.txt. Subjects the declaration
// is silent about are NOT listed, and `Allow-Use` lists only unconditional allows.

import type { Declaration } from "./model";
import { SUBJECTS } from "./model";
import {
  aiprefValues,
  axisStates,
  contentSignalFromStates,
  contentUsageValue,
  scopesOf,
  tdmState,
} from "./resolve";

export function renderAiTxt(decl: Declaration, opts: { id?: string } = {}): string {
  const L: string[] = [];
  L.push(`# ai.txt for ${decl.domain}`);
  L.push(`# Declaration version ${decl.version}${opts.id ? ` (${opts.id})` : ""}${decl.publishedAt ? `, published ${decl.publishedAt}` : ""}`);
  L.push("# This file states preferences. It does not block anything.");
  L.push("# Subjects not listed are not stated: silence is not permission.");
  L.push("", `Domain: ${decl.domain}`);
  if (opts.id) L.push(`Declaration: ${opts.id}`);
  if (decl.contact) L.push(`Contact: ${decl.contact}`);
  if (decl.licence) L.push(`Licence: ${decl.licence}`);
  for (const s of scopesOf(decl)) {
    L.push("", `Scope: ${s.pattern ?? "/"}`);
    const allow = SUBJECTS.filter((x) => s.stances[x]?.stance === "allow");
    const deny = SUBJECTS.filter((x) => s.stances[x]?.stance === "deny");
    if (allow.length) L.push(`Allow-Use: ${allow.join(", ")}`);
    if (deny.length) L.push(`Disallow-Use: ${deny.join(", ")}`);
    for (const x of SUBJECTS) {
      const d = s.stances[x];
      if (d?.stance === "conditional") L.push(`Conditional-Use: ${x}: ${d.condition}`);
    }
    const cs = contentSignalFromStates(axisStates(s.stances));
    if (cs) L.push(`Content-Signal: ${cs}`);
    const cu = contentUsageValue(aiprefValues(s.stances));
    if (cu) L.push(`Content-Usage: ${cu}`);
    const tdm = tdmState(s.stances);
    if (tdm !== null) L.push(`TDM-Reservation: ${tdm}`);
  }
  if (decl.notes) {
    L.push("");
    for (const line of decl.notes.split(/\r?\n/)) L.push(`# ${line}`.trimEnd());
  }
  return L.join("\n") + "\n";
}
