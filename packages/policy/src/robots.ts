// Ported from llms-txt/src/policy-set.ts + runtime/llmstxt/src/bots.ts (goplainly-v6-2026-11-10-current-dormant)
//
// robots.txt projections: per-UA blocks, the `__usage_ai-training` token block,
// the Content-Signal line and AIPREF `Content-Usage` rules.
//
// RFC 9309 expresses crawl access per user-agent, never per purpose. So a user
// agent gets a Disallow only when EVERY subject it serves is declared and none
// is allow; a user agent serving both a permitted and a refused purpose gets
// no directive (a Disallow would also deny the permitted use, and the absence
// of a rule is not a grant either). `Allow` is written only where it carves a
// declared exception out of a declared block, or for the explicit training token.

import type { Declaration, Subject } from "./model";
import {
  aiprefValues,
  axisStates,
  contentSignalFromStates,
  contentUsageValue,
  meetAxisStates,
  parentPattern,
  scopesOf,
  staticAgentStances,
  type Scope,
  type StanceMap,
} from "./resolve";

/** The robots.txt policy token from draft-kelley-aipref-training-preference-signal. `*` never matches it. */
export const USAGE_TRAINING_TOKEN = "__usage_ai-training";

export type RobotsAgent = {
  /** The robots.txt product token, e.g. `GPTBot`. */
  readonly token: string;
  readonly vendor: string;
  /** The declaration subjects whose stance drives this token. */
  readonly subjects: readonly Subject[];
  readonly note?: string;
};

/** Vendor-documented purpose of each crawler, in the declaration's vocabulary. */
export const ROBOTS_AGENTS: readonly RobotsAgent[] = [
  { token: "GPTBot", vendor: "OpenAI", subjects: ["train"] },
  { token: "OAI-SearchBot", vendor: "OpenAI", subjects: ["index"] },
  { token: "ChatGPT-User", vendor: "OpenAI", subjects: ["infer"], note: "user-triggered fetches may not follow robots.txt" },
  { token: "ClaudeBot", vendor: "Anthropic", subjects: ["train"] },
  { token: "Claude-SearchBot", vendor: "Anthropic", subjects: ["index"] },
  { token: "Claude-User", vendor: "Anthropic", subjects: ["infer"], note: "user-triggered fetches may not follow robots.txt" },
  { token: "Google-Extended", vendor: "Google", subjects: ["train"] },
  { token: "PerplexityBot", vendor: "Perplexity", subjects: ["index"] },
  { token: "CCBot", vendor: "Common Crawl", subjects: ["train"] },
  { token: "Applebot-Extended", vendor: "Apple", subjects: ["train"] },
  { token: "Bytespider", vendor: "ByteDance", subjects: ["train"] },
  { token: "meta-externalagent", vendor: "Meta", subjects: ["train"] },
];

export type CrawlState = "block" | "allow" | "silent";

function stateOfSubjects(m: StanceMap, subjects: readonly Subject[]): CrawlState {
  const declared = subjects.map((s) => m[s]).filter((d) => !!d);
  if (declared.length === 0) return "silent";
  if (declared.every((d) => d!.stance === "allow")) return "allow";
  if (declared.every((d) => d!.stance !== "allow")) return "block";
  return "silent"; // mixed: robots.txt cannot say it
}

/** Rule lines for one crawler/token group, given its state at every scope. */
function groupRules(
  decl: Declaration,
  stateAt: (scope: Scope) => CrawlState,
  explicitAllow: boolean,
): string[] {
  const scopes = scopesOf(decl);
  const stateByPattern = new Map<string | null, CrawlState>(scopes.map((s) => [s.pattern, stateAt(s)]));
  const rules: string[] = [];
  const root = stateByPattern.get(null)!;
  if (root === "block") rules.push("Disallow: /");
  else if (root === "allow" && explicitAllow) rules.push("Allow: /");
  for (const scope of scopes) {
    if (scope.pattern === null) continue;
    const parent = stateByPattern.get(parentPattern(decl, scope.pattern)) ?? "silent";
    const st = stateByPattern.get(scope.pattern)!;
    if (st === parent || st === "silent") continue;
    if (st === "block") rules.push(`Disallow: ${scope.pattern}`);
    else if (explicitAllow || parent === "block") rules.push(`Allow: ${scope.pattern}`);
  }
  return rules;
}

export type RobotsRender = {
  readonly text: string;
  readonly notes: readonly string[];
};

/** Names every agent override that cannot be projected statically. */
function agentNotes(decl: Declaration): string[] {
  const notes: string[] = [];
  for (const o of decl.agents) {
    const loosening = o.directives.filter((d) => d.stance === "allow");
    if (loosening.length > 0) {
      notes.push(
        `Agent "${o.agent}": allow for ${loosening.map((d) => d.subject).join(", ")} is not written to robots.txt; it applies only to a request whose identity is verified at runtime.`,
      );
    }
  }
  return notes;
}

/**
 * The robots.txt policy block: provenance comments, the `*` group carrying the
 * Content-Signal line and AIPREF Content-Usage rules, the training-token
 * group, and one group per user agent that the declaration blocks.
 */
export function renderRobots(decl: Declaration, opts: { id?: string; rslUrl?: string | null } = {}): RobotsRender {
  const scopes = scopesOf(decl);
  const notes: string[] = [...agentNotes(decl)];
  const L: string[] = [];
  L.push(`# AI usage policy for ${decl.domain} (declaration version ${decl.version}${opts.id ? `, ${opts.id}` : ""})`);
  L.push("# A statement of preference, not an enforcement mechanism: it blocks nothing.");
  L.push("# The absence of a rule below is not a grant of any use.");

  // `*` group: Content-Signal (one value valid on every path) and Content-Usage (per path).
  const star: string[] = [];
  const csRoot = contentSignalFromStates(meetAxisStates(scopes.map((s) => axisStates(s.stances))));
  if (csRoot) star.push(`Content-Signal: ${csRoot}`);
  if (decl.paths.length > 0) {
    notes.push("The robots.txt Content-Signal line has no path syntax, so it carries the most restrictive value over every scope; per-path values travel in the response headers.");
  }
  const usageByPattern = new Map<string | null, string | null>(
    scopes.map((s) => [s.pattern, contentUsageValue(aiprefValues(s.stances))]),
  );
  const rootUsage = usageByPattern.get(null) ?? null;
  if (rootUsage) star.push(`Content-Usage: ${rootUsage}`);
  for (const s of scopes) {
    if (s.pattern === null) continue;
    const v = usageByPattern.get(s.pattern) ?? null;
    const parent = usageByPattern.get(parentPattern(decl, s.pattern)) ?? null;
    if (v && v !== parent) star.push(`Content-Usage: ${s.pattern} ${v}`);
  }
  if (star.length > 0) {
    L.push("", "User-Agent: *", ...star);
  }

  // The training-preference token. Driven by the ai-train axis, like Content-Signal.
  const tokenRules = groupRules(
    decl,
    (s) => {
      const a = axisStates(s.stances)["ai-train"];
      return a === null ? "silent" : a === "yes" ? "allow" : "block";
    },
    true,
  );
  if (tokenRules.length > 0) {
    L.push("", `User-Agent: ${USAGE_TRAINING_TOKEN}`, ...tokenRules);
  }

  // Registered crawlers (restrictive projections only).
  const known = new Set(ROBOTS_AGENTS.map((a) => a.token.toLowerCase()));
  for (const agent of ROBOTS_AGENTS) {
    const rules = groupRules(
      decl,
      (s) => stateOfSubjects(staticAgentStances(decl, agent.token, s.stances), agent.subjects),
      false,
    );
    if (rules.length > 0) {
      L.push("", `# ${agent.vendor}: ${agent.subjects.join(", ")}${agent.note ? ` (${agent.note})` : ""}`, `User-agent: ${agent.token}`, ...rules);
    }
  }
  // Overridden agents outside the registry: their own overrides define what they serve.
  for (const o of decl.agents) {
    if (known.has(o.agent.toLowerCase())) continue;
    // Only the restrictive overrides define what an unregistered agent is blocked from.
    const subjects = o.directives.filter((d) => d.stance !== "allow").map((d) => d.subject);
    if (subjects.length === 0) continue;
    const rules = groupRules(
      decl,
      (s) => stateOfSubjects(staticAgentStances(decl, o.agent, s.stances), subjects),
      false,
    );
    if (rules.length > 0) L.push("", `# Per-agent override`, `User-agent: ${o.agent}`, ...rules);
  }

  if (opts.rslUrl) L.push("", `License: ${opts.rslUrl}`);
  return { text: L.join("\n") + "\n", notes };
}
