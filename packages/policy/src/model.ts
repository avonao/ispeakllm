// Ported from runtime/emissary/src/declaration.ts (trustvice-v3-2026-11-10-current)
//
// The declaration model: six subjects x three stances, domain defaults,
// per-path overrides and per-agent overrides, plus validation and a canonical
// form. Pure module: no I/O, no clock, no dependencies (WebCrypto only).
//
// A declaration is a STATEMENT of permitted use, not an enforcement mechanism.
// Nothing served over HTTP can block a crawler. Silence on a subject is neither
// permission nor refusal; it is a gap, and no projection fills it in.

export const SUBJECTS = ["index", "infer", "quote", "embed", "train", "evaluate"] as const;
export type Subject = (typeof SUBJECTS)[number];

export const STANCES = ["allow", "deny", "conditional"] as const;
export type Stance = (typeof STANCES)[number];

export type Directive = {
  readonly subject: Subject;
  readonly stance: Stance;
  /** Required when the stance is `conditional`; forbidden otherwise. */
  readonly condition?: string;
};

export type PathOverride = { readonly pattern: string; readonly directives: readonly Directive[] };
export type AgentOverride = { readonly agent: string; readonly directives: readonly Directive[] };

/** What a caller supplies. Validated, then turned into a {@link Declaration}. */
export type DeclarationInput = {
  /** The origin this declaration governs, e.g. `example.com`. */
  readonly domain: string;
  readonly version?: number;
  readonly publishedAt?: string | null;
  /** Domain-wide stances. */
  readonly defaults: readonly Directive[];
  /** Per-path overrides: a path prefix (`/blog/`, trailing `*` optional). */
  readonly paths?: readonly PathOverride[];
  /** Per-agent overrides keyed by robots product token (`GPTBot`). */
  readonly agents?: readonly AgentOverride[];
  readonly contact?: string | null;
  readonly licence?: string | null;
  readonly notes?: string | null;
};

/** The canonical, validated form. Every optional field is explicit. */
export type Declaration = {
  readonly domain: string;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly defaults: readonly Directive[];
  readonly paths: readonly PathOverride[];
  readonly agents: readonly AgentOverride[];
  readonly contact: string | null;
  readonly licence: string | null;
  readonly notes: string | null;
};

export const DECLARATION_ERROR_CODES = [
  "not_an_object",
  "no_domain",
  "invalid_domain",
  "invalid_version",
  "invalid_published_at",
  "no_directives",
  "invalid_directive",
  "invalid_subject",
  "invalid_stance",
  "duplicate_subject",
  "conditional_without_condition",
  "empty_condition",
  "condition_on_non_conditional",
  "invalid_text",
  "invalid_path",
  "path_is_root",
  "duplicate_path",
  "invalid_agent",
  "duplicate_agent",
  "empty_override",
] as const;
export type DeclarationErrorCode = (typeof DECLARATION_ERROR_CODES)[number];

export type DeclarationIssue = {
  readonly code: DeclarationErrorCode;
  /** Where in the input, e.g. `paths[1].directives[0].subject`. */
  readonly path: string;
  readonly message: string;
};

export type ValidationResult =
  | { readonly ok: true; readonly declaration: Declaration }
  | { readonly ok: false; readonly errors: readonly DeclarationIssue[] };

export class DeclarationError extends Error {
  readonly errors: readonly DeclarationIssue[];
  constructor(errors: readonly DeclarationIssue[]) {
    super(`Invalid declaration: ${errors.map((e) => `${e.path}: ${e.code}`).join("; ")}`);
    this.name = "DeclarationError";
    this.errors = errors;
  }
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_TEXT = 500;
const MAX_NOTES = 4000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Strip a single trailing `*` from a path pattern: patterns are prefixes. */
export function normalisePathPattern(pattern: string): string {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
}

function validateDirectives(
  raw: unknown,
  at: string,
  errors: DeclarationIssue[],
): Directive[] {
  const out: Directive[] = [];
  if (!Array.isArray(raw)) {
    errors.push({ code: "invalid_directive", path: at, message: "Directives must be an array." });
    return out;
  }
  const seen = new Set<string>();
  raw.forEach((d, i) => {
    const p = `${at}[${i}]`;
    if (!isObject(d)) {
      errors.push({ code: "invalid_directive", path: p, message: "A directive must be an object." });
      return;
    }
    const subject = d.subject;
    const stance = d.stance;
    let ok = true;
    if (typeof subject !== "string" || !(SUBJECTS as readonly string[]).includes(subject)) {
      errors.push({ code: "invalid_subject", path: `${p}.subject`, message: `Subject must be one of ${SUBJECTS.join(", ")}.` });
      ok = false;
    }
    if (typeof stance !== "string" || !(STANCES as readonly string[]).includes(stance)) {
      errors.push({ code: "invalid_stance", path: `${p}.stance`, message: `Stance must be one of ${STANCES.join(", ")}.` });
      ok = false;
    }
    if (!ok) return;
    if (seen.has(subject as string)) {
      // Two stances on one subject is an ambiguity, and an ambiguity is
      // resolved by whoever reads it, in their own favour.
      errors.push({ code: "duplicate_subject", path: `${p}.subject`, message: `Subject "${subject as string}" is declared twice.` });
      return;
    }
    seen.add(subject as string);
    const condition = d.condition;
    if (stance === "conditional") {
      if (typeof condition !== "string") {
        errors.push({ code: "conditional_without_condition", path: `${p}.condition`, message: `Subject "${subject as string}" is conditional but states no condition.` });
        return;
      }
      const c = condition.trim();
      if (c.length === 0) {
        errors.push({ code: "empty_condition", path: `${p}.condition`, message: "A condition must not be empty." });
        return;
      }
      if (c.length > MAX_TEXT || CONTROL_RE.test(c)) {
        errors.push({ code: "invalid_text", path: `${p}.condition`, message: `A condition must be a single line of at most ${MAX_TEXT} characters.` });
        return;
      }
      out.push({ subject: subject as Subject, stance: "conditional", condition: c });
    } else {
      if (condition !== undefined && condition !== null) {
        errors.push({ code: "condition_on_non_conditional", path: `${p}.condition`, message: "Only a conditional stance may carry a condition." });
        return;
      }
      out.push({ subject: subject as Subject, stance: stance as Stance });
    }
  });
  return out.sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject));
}

function optionalText(
  raw: unknown,
  at: string,
  errors: DeclarationIssue[],
  multiline: boolean,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({ code: "invalid_text", path: at, message: "Must be a string." });
    return null;
  }
  const t = raw.trim();
  if (t === "") return null;
  const limit = multiline ? MAX_NOTES : MAX_TEXT;
  const bad = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t) : CONTROL_RE.test(t);
  if (t.length > limit || bad) {
    errors.push({ code: "invalid_text", path: at, message: `Must be at most ${limit} characters${multiline ? "" : " on a single line"}, with no control characters.` });
    return null;
  }
  return t;
}

/**
 * Validate and canonicalise a declaration. Returns EVERY problem found, each
 * typed and named; there is no path that accepts a declaration whose
 * directives contradict each other or say nothing.
 */
export function validateDeclaration(input: unknown): ValidationResult {
  const errors: DeclarationIssue[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ code: "not_an_object", path: "", message: "A declaration must be an object." }] };
  }

  let domain = "";
  if (typeof input.domain !== "string" || input.domain.trim() === "") {
    errors.push({ code: "no_domain", path: "domain", message: "A declaration governs a domain; `domain` is required." });
  } else {
    domain = input.domain.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) {
      errors.push({ code: "invalid_domain", path: "domain", message: "`domain` must be a bare host name (no scheme, path or spaces)." });
    }
  }

  let version = 1;
  if (input.version !== undefined) {
    if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
      errors.push({ code: "invalid_version", path: "version", message: "`version` must be a positive integer." });
    } else version = input.version;
  }

  let publishedAt: string | null = null;
  if (input.publishedAt !== undefined && input.publishedAt !== null) {
    if (typeof input.publishedAt !== "string" || Number.isNaN(Date.parse(input.publishedAt))) {
      errors.push({ code: "invalid_published_at", path: "publishedAt", message: "`publishedAt` must be an ISO 8601 timestamp." });
    } else publishedAt = input.publishedAt;
  }

  const rawDefaults: unknown = input.defaults ?? [];
  const defaults = validateDirectives(rawDefaults, "defaults", errors);
  if (Array.isArray(rawDefaults) && rawDefaults.length === 0) {
    errors.push({
      code: "no_directives",
      path: "defaults",
      message: "A declaration with no directives states nothing. Publishing one would give a crawler no position to respect.",
    });
  }

  const paths: PathOverride[] = [];
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths)) {
      errors.push({ code: "invalid_path", path: "paths", message: "`paths` must be an array." });
    } else {
      const seen = new Set<string>();
      input.paths.forEach((p: unknown, i: number) => {
        const at = `paths[${i}]`;
        if (!isObject(p) || typeof p.pattern !== "string") {
          errors.push({ code: "invalid_path", path: at, message: "A path override needs a string `pattern`." });
          return;
        }
        const pattern = normalisePathPattern(p.pattern.trim());
        if (!pattern.startsWith("/") || pattern.length > 512 || /[\s#$*?]/.test(pattern) || CONTROL_RE.test(pattern)) {
          errors.push({ code: "invalid_path", path: `${at}.pattern`, message: "A path pattern starts with `/`, may end in `*`, and contains no whitespace, `#`, `$`, `?` or inner `*`." });
          return;
        }
        if (pattern === "/") {
          errors.push({ code: "path_is_root", path: `${at}.pattern`, message: "Use `defaults` for the whole domain, not a `/` path override." });
          return;
        }
        if (seen.has(pattern)) {
          errors.push({ code: "duplicate_path", path: `${at}.pattern`, message: `Path "${pattern}" is overridden twice.` });
          return;
        }
        seen.add(pattern);
        const directives = validateDirectives(p.directives ?? [], `${at}.directives`, errors);
        if (directives.length === 0 && Array.isArray(p.directives ?? [])) {
          errors.push({ code: "empty_override", path: `${at}.directives`, message: "A path override with no directives states nothing." });
        }
        paths.push({ pattern, directives });
      });
    }
  }
  paths.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));

  const agents: AgentOverride[] = [];
  if (input.agents !== undefined) {
    if (!Array.isArray(input.agents)) {
      errors.push({ code: "invalid_agent", path: "agents", message: "`agents` must be an array." });
    } else {
      const seen = new Set<string>();
      input.agents.forEach((a: unknown, i: number) => {
        const at = `agents[${i}]`;
        if (!isObject(a) || typeof a.agent !== "string" || !AGENT_RE.test(a.agent.trim())) {
          errors.push({ code: "invalid_agent", path: `${at}.agent`, message: "An agent override needs a robots product token such as `GPTBot`." });
          return;
        }
        const agent = a.agent.trim();
        if (seen.has(agent.toLowerCase())) {
          errors.push({ code: "duplicate_agent", path: `${at}.agent`, message: `Agent "${agent}" is overridden twice.` });
          return;
        }
        seen.add(agent.toLowerCase());
        const directives = validateDirectives(a.directives ?? [], `${at}.directives`, errors);
        if (directives.length === 0 && Array.isArray(a.directives ?? [])) {
          errors.push({ code: "empty_override", path: `${at}.directives`, message: "An agent override with no directives states nothing." });
        }
        agents.push({ agent, directives });
      });
    }
  }
  agents.sort((a, b) => (a.agent.toLowerCase() < b.agent.toLowerCase() ? -1 : a.agent.toLowerCase() > b.agent.toLowerCase() ? 1 : 0));

  const contact = optionalText(input.contact, "contact", errors, false);
  const licence = optionalText(input.licence, "licence", errors, false);
  const notes = optionalText(input.notes, "notes", errors, true);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, declaration: { domain, version, publishedAt, defaults, paths, agents, contact, licence, notes } };
}

/** Validate or throw {@link DeclarationError}. */
export function parseDeclaration(input: unknown): Declaration {
  const r = validateDeclaration(input);
  if (!r.ok) throw new DeclarationError(r.errors);
  return r.declaration;
}

/* ── Canonical bytes and content-addressed id ───────────────────────── */

function jcs(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value of type ${typeof v}`);
}

/** The canonical JSON of a declaration: sorted keys, no whitespace (JCS-compatible for this value space). */
export function canonicalDeclaration(declaration: Declaration): string {
  return jcs(declaration);
}

async function sha256Base64Url(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `emd_` + base64url(sha256(canonical bytes)). The same declaration always yields the same id. */
export async function declarationId(declaration: Declaration): Promise<string> {
  return `emd_${await sha256Base64Url(canonicalDeclaration(declaration))}`;
}

export type ComposedDeclaration = {
  readonly ok: true;
  readonly declaration: Declaration;
  readonly canonical: string;
  readonly id: string;
};

/** Validate, canonicalise and address in one step. */
export async function composeDeclaration(
  input: unknown,
): Promise<ComposedDeclaration | { readonly ok: false; readonly errors: readonly DeclarationIssue[] }> {
  const r = validateDeclaration(input);
  if (!r.ok) return r;
  const canonical = canonicalDeclaration(r.declaration);
  return { ok: true, declaration: r.declaration, canonical, id: `emd_${await sha256Base64Url(canonical)}` };
}

/** The stance taken on one subject, or null when the declaration is silent. */
export function stanceFor(directives: readonly Directive[], subject: Subject): Directive | null {
  return directives.find((d) => d.subject === subject) ?? null;
}

/** Subjects a set of directives says nothing about. Surfaced, never defaulted. */
export function silentSubjects(directives: readonly Directive[]): readonly Subject[] {
  const declared = new Set(directives.map((d) => d.subject));
  return SUBJECTS.filter((s) => !declared.has(s));
}
