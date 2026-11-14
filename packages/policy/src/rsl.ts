// Ported from llms-txt/src/policy-set.ts `renderRsl` (goplainly-v6-2026-11-10-current-dormant)
//
// RSL 1.0 (Really Simple Licensing) projection: one <content> per scope, with
// <permits>/<prohibits> over the usage terms ai-train, ai-input and search
// (collapsed to `all` when all three agree). `conditional` cannot be expressed
// in RSL's usage terms, so it is listed under <prohibits> with the condition
// preserved in a comment: never more permissive than the declaration.

import type { Declaration } from "./model";
import { CONTENT_SIGNAL_AXES, axisStates, scopesOf, type ContentSignalAxis } from "./resolve";

const RSL_TERM: Record<ContentSignalAxis, string> = {
  "ai-train": "ai-train",
  "ai-input": "ai-input",
  search: "search",
};

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeComment = (s: string): string => s.replace(/--+/g, "-").replace(/>/g, "&gt;");

/** RSL 1.0 XML, or null when the declaration is silent on all three axes in every scope. */
export function renderRsl(decl: Declaration, opts: { origin?: string } = {}): string | null {
  const origin = (opts.origin ?? `https://${decl.domain}`).replace(/\/+$/, "");
  const blocks: string[] = [];
  for (const scope of scopesOf(decl)) {
    const states = axisStates(scope.stances);
    const permits = CONTENT_SIGNAL_AXES.filter((a) => states[a] === "yes");
    const prohibits = CONTENT_SIGNAL_AXES.filter((a) => states[a] === "no");
    if (permits.length === 0 && prohibits.length === 0) continue;
    const url = `${origin}${scope.pattern ?? "/"}*`;
    const termsOf = (axes: readonly ContentSignalAxis[]): string =>
      axes.length === CONTENT_SIGNAL_AXES.length ? "all" : axes.map((a) => RSL_TERM[a]).join(",");
    const lines: string[] = [`  <content url="${escapeXml(url)}">`, "    <license>"];
    if (permits.length > 0) lines.push(`      <permits type="usage">${termsOf(permits)}</permits>`);
    if (prohibits.length > 0) {
      lines.push(`      <prohibits type="usage">${termsOf(prohibits)}</prohibits>`);
      const conds = Object.values(scope.stances).filter((d) => d && d.stance === "conditional");
      for (const d of conds) {
        lines.push(`      <!-- ${d!.subject} is conditional (${escapeComment(d!.condition ?? "")}); RSL cannot carry the condition, so it is not permitted here -->`);
      }
    }
    lines.push("    </license>");
    if (scope.pattern === null && decl.licence && /^https:\/\//.test(decl.licence)) {
      lines.push(`    <terms>${escapeXml(decl.licence)}</terms>`);
    }
    lines.push("  </content>");
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Derived from the AI usage declaration for ${escapeComment(decl.domain)} (version ${decl.version}). Where RSL has no faithful term the declaration governs; silence is not a grant. -->`,
    '<rsl xmlns="https://rslstandard.org/rsl">',
    ...blocks,
    "</rsl>",
    "",
  ].join("\n");
}
