// Ported from runtime/emissary/src/content-signal.ts (trustvice-v3-2026-11-10-current)
//
// Scope resolution and the conservative axis reduction every projection shares.
//
// THE RULE EVERY PROJECTION OBEYS: never more permissive than the declaration.
//   - silence is never turned into permission, and never into refusal;
//   - `conditional` cannot be carried by a binary format, so it reads as "no";
//   - one `deny` among `allow`s on the same axis wins;
//   - per-agent overrides that LOOSEN a stance need a verified identity, so a
//     static artifact (which cannot verify anyone) never carries them.

import {
  SUBJECTS,
  normalisePathPattern,
  type Declaration,
  type Directive,
  type Stance,
  type Subject,
} from "./model";

/** The three Content Signals Policy axes, in canonical header order. */
export const CONTENT_SIGNAL_AXES = ["search", "ai-input", "ai-train"] as const;
export type ContentSignalAxis = (typeof CONTENT_SIGNAL_AXES)[number];

/** Which subjects feed each axis. */
export const AXIS_SUBJECTS: Readonly<Record<ContentSignalAxis, readonly Subject[]>> = {
  search: ["index"],
  "ai-input": ["infer", "quote", "embed"],
  "ai-train": ["train", "evaluate"],
};

export type ContentSignalValue = "yes" | "no";

/** A stance map for one scope. Absent key = silent. */
export type StanceMap = Partial<Record<Subject, Directive>>;

export function toStanceMap(directives: readonly Directive[]): StanceMap {
  const m: StanceMap = {};
  for (const d of directives) m[d.subject] = d;
  return m;
}

export function fromStanceMap(m: StanceMap): Directive[] {
  const out: Directive[] = [];
  for (const s of SUBJECTS) {
    const d = m[s];
    if (d) out.push(d);
  }
  return out;
}

/**
 * The value for one axis, or `null` when every contributing subject is silent.
 * `null` means OMIT the axis; never emit `axis=no` for silence.
 *   - every non-silent contributor is `allow` -> yes
 *   - anything else (any deny, any conditional) -> no
 */
export function axisValue(directives: readonly Directive[], axis: ContentSignalAxis): ContentSignalValue | null {
  const contributors = directives.filter((d) => AXIS_SUBJECTS[axis].includes(d.subject));
  if (contributors.length === 0) return null;
  return contributors.every((d) => d.stance === "allow") ? "yes" : "no";
}

export type AxisStates = Readonly<Record<ContentSignalAxis, ContentSignalValue | null>>;

export function axisStates(m: StanceMap): AxisStates {
  const ds = fromStanceMap(m);
  return {
    search: axisValue(ds, "search"),
    "ai-input": axisValue(ds, "ai-input"),
    "ai-train": axisValue(ds, "ai-train"),
  };
}

/* ── Scopes ─────────────────────────────────────────────────────────── */

export type Scope = {
  /** `null` is the domain default. Otherwise a normalised path prefix. */
  readonly pattern: string | null;
  /** Effective stances: defaults overlaid by every enclosing path override, then this one. */
  readonly stances: StanceMap;
};

function overlay(base: StanceMap, over: readonly Directive[]): StanceMap {
  const out: StanceMap = { ...base };
  for (const d of over) out[d.subject] = d;
  return out;
}

/** Declared patterns that are prefixes of `path`, shortest first. */
function enclosing(decl: Declaration, path: string): string[] {
  return decl.paths
    .map((p) => p.pattern)
    .filter((p) => path.startsWith(p))
    .sort((a, b) => a.length - b.length);
}

/** Effective stances for a path (no agent), by longest-prefix inheritance. */
export function stancesForPath(decl: Declaration, path: string | null): StanceMap {
  let m = toStanceMap(decl.defaults);
  if (path === null) return m;
  for (const pat of enclosing(decl, path)) {
    const o = decl.paths.find((p) => p.pattern === pat)!;
    m = overlay(m, o.directives);
  }
  return m;
}

/** Root first, then one scope per declared path (sorted), each with effective stances. */
export function scopesOf(decl: Declaration): Scope[] {
  return [
    { pattern: null, stances: stancesForPath(decl, null) },
    ...decl.paths.map((p) => ({ pattern: p.pattern, stances: stancesForPath(decl, p.pattern) })),
  ];
}

/** The nearest declared ancestor pattern of `pattern`, or null for root. */
export function parentPattern(decl: Declaration, pattern: string): string | null {
  const anc = enclosing(decl, pattern).filter((p) => p !== pattern);
  return anc.length ? anc[anc.length - 1]! : null;
}

const RANK: Record<Stance, number> = { deny: 0, conditional: 1, allow: 2 };

/** The more restrictive of two directives on the same subject. */
function meet(a: Directive, b: Directive): Directive {
  return RANK[a.stance] <= RANK[b.stance] ? a : b;
}

function agentOverride(decl: Declaration, agent: string | null | undefined) {
  if (!agent) return null;
  const a = agent.toLowerCase();
  return decl.agents.find((o) => o.agent.toLowerCase() === a) ?? null;
}

/**
 * STATIC view for one agent at one scope: only restrictive overrides apply.
 * A static artifact cannot verify who is reading it, so an override that would
 * loosen the default is not projected. Silence stays silent unless the agent
 * override denies/conditions that subject.
 */
export function staticAgentStances(decl: Declaration, agent: string, base: StanceMap): StanceMap {
  const ov = agentOverride(decl, agent);
  if (!ov) return base;
  const out: StanceMap = { ...base };
  for (const d of ov.directives) {
    if (d.stance === "allow") continue; // loosening or neutral: needs runtime verification
    const cur = out[d.subject];
    out[d.subject] = cur ? meet(cur, d) : d;
  }
  return out;
}

export type ResolveContext = {
  readonly path?: string | null;
  readonly agent?: string | null;
  /**
   * True only when the caller has VERIFIED this agent's identity (grade
   * `verified`). A verified agent gets its override in full, including a
   * loosening one. An unverified agent only ever gets the restrictive ones.
   */
  readonly verified?: boolean;
};

/** The effective stance for one subject at runtime, or null when the declaration is silent. */
export function resolveStance(decl: Declaration, subject: Subject, ctx: ResolveContext = {}): Directive | null {
  const base = stancesForPath(decl, ctx.path ?? null);
  const ov = agentOverride(decl, ctx.agent);
  const baseD = base[subject] ?? null;
  const o = ov?.directives.find((d) => d.subject === subject) ?? null;
  if (!o) return baseD;
  if (ctx.verified) return o;
  if (o.stance === "allow") return baseD;
  return baseD ? meet(baseD, o) : o;
}

/* ── Content-Signal ─────────────────────────────────────────────────── */

/** Build a `Content-Signal` value, or null when every axis is silent. */
export function contentSignalHeader(directives: readonly Directive[]): string | null {
  const parts: string[] = [];
  for (const axis of CONTENT_SIGNAL_AXES) {
    const v = axisValue(directives, axis);
    if (v !== null) parts.push(`${axis}=${v}`);
  }
  return parts.length ? parts.join(", ") : null;
}

export function contentSignalFromStates(s: AxisStates): string | null {
  const parts: string[] = [];
  for (const axis of CONTENT_SIGNAL_AXES) if (s[axis] !== null) parts.push(`${axis}=${s[axis]}`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Combine axis states over several scopes into ONE value valid everywhere
 * (for formats with no path syntax, e.g. the robots.txt Content-Signal line).
 * `no` if any scope says no; `yes` only if EVERY scope says yes; otherwise omit.
 */
export function meetAxisStates(all: readonly AxisStates[]): AxisStates {
  const out = {} as Record<ContentSignalAxis, ContentSignalValue | null>;
  for (const axis of CONTENT_SIGNAL_AXES) {
    const vs = all.map((s) => s[axis]);
    out[axis] = vs.includes("no") ? "no" : vs.length > 0 && vs.every((v) => v === "yes") ? "yes" : null;
  }
  return out;
}

/* ── IETF AIPREF vocabulary (draft-ietf-aipref-vocab) ───────────────── */

export const AIPREF_CATEGORIES = ["train-ai", "ai-use", "search"] as const;
export type AiprefCategory = (typeof AIPREF_CATEGORIES)[number];
export type AiprefValues = Partial<Record<AiprefCategory, "y" | "n">>;

const AI_USE_SUBJECTS: readonly Subject[] = ["train", "evaluate", "infer", "quote", "embed"];

/**
 * train-ai <- the ai-train axis; search <- the search axis.
 * ai-use covers every AI subject: `y` only when ALL five are declared allow,
 * `n` when at least one is declared and none is allow, omitted when mixed
 * (the vocabulary cannot say "some uses"; the mixed picture is carried by
 * train-ai and by the other formats).
 */
export function aiprefValues(m: StanceMap): AiprefValues {
  const s = axisStates(m);
  const out: AiprefValues = {};
  if (s["ai-train"] !== null) out["train-ai"] = s["ai-train"] === "yes" ? "y" : "n";
  const declared = AI_USE_SUBJECTS.map((x) => m[x]).filter((d): d is Directive => !!d);
  if (declared.length === AI_USE_SUBJECTS.length && declared.every((d) => d.stance === "allow")) out["ai-use"] = "y";
  else if (declared.length > 0 && declared.every((d) => d.stance !== "allow")) out["ai-use"] = "n";
  if (s.search !== null) out.search = s.search === "yes" ? "y" : "n";
  return out;
}

/** `train-ai=n, ai-use=n, search=y`, or null when nothing is stated. */
export function contentUsageValue(v: AiprefValues): string | null {
  const parts = AIPREF_CATEGORIES.filter((c) => v[c] !== undefined).map((c) => `${c}=${v[c]}`);
  return parts.length ? parts.join(", ") : null;
}

/** The TDM reservation state of a scope: 1 reserved, 0 not reserved, null silent. */
export function tdmState(m: StanceMap): 0 | 1 | null {
  const s = axisStates(m)["ai-train"];
  return s === null ? null : s === "no" ? 1 : 0;
}

export { normalisePathPattern };
