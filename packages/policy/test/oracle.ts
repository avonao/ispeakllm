// An INDEPENDENT oracle for the "never more permissive" property. It reads the
// declaration input directly and parses the RENDERED text of every projection;
// it shares no code with src/resolve.ts or the renderers.

export type Subj = "index" | "infer" | "quote" | "embed" | "train" | "evaluate";
export type Stn = "allow" | "deny" | "conditional";
export type Dir = { subject: Subj; stance: Stn; condition?: string };
export type RawDecl = {
  domain: string;
  defaults: Dir[];
  paths?: { pattern: string; directives: Dir[] }[];
  agents?: { agent: string; directives: Dir[] }[];
};
export type Stances = Partial<Record<Subj, Stn>>;

export const SEARCH: Subj[] = ["index"];
export const INPUT: Subj[] = ["infer", "quote", "embed"];
export const TRAIN: Subj[] = ["train", "evaluate"];
export const ALL_AI: Subj[] = ["train", "evaluate", "infer", "quote", "embed"];

const norm = (p: string): string => (p.endsWith("*") ? p.slice(0, -1) : p);

/** Declared stances at `path`: defaults, then every declared prefix pattern, shortest first. */
export function stancesAt(d: RawDecl, path: string): Stances {
  const out: Stances = {};
  for (const x of d.defaults) out[x.subject] = x.stance;
  const pats = (d.paths ?? []).map((p) => ({ ...p, pattern: norm(p.pattern) })).filter((p) => path.startsWith(p.pattern));
  pats.sort((a, b) => a.pattern.length - b.pattern.length);
  for (const p of pats) for (const x of p.directives) out[x.subject] = x.stance;
  return out;
}

/** What a STATIC artifact may say about `agent`: restrictive overrides only. */
export function agentStancesAt(d: RawDecl, path: string, agent: string): Stances {
  const out = stancesAt(d, path);
  const o = (d.agents ?? []).find((a) => a.agent.toLowerCase() === agent.toLowerCase());
  if (!o) return out;
  for (const x of o.directives) {
    if (x.stance === "allow") continue;
    const cur = out[x.subject];
    out[x.subject] = cur === "deny" ? "deny" : x.stance === "deny" ? "deny" : x.stance;
  }
  return out;
}

/** A projection may only say "permitted" if every subject is declared allow (and at least one is declared when `needSome`). */
export function canPermit(s: Stances, subjects: Subj[], mode: "declared-all" | "contributors"): boolean {
  if (mode === "declared-all") return subjects.every((x) => s[x] === "allow");
  const declared = subjects.filter((x) => s[x] !== undefined);
  return declared.length > 0 && declared.every((x) => s[x] === "allow");
}

export const anyDeclared = (s: Stances, subjects: Subj[]): boolean => subjects.some((x) => s[x] !== undefined);

/** Every path worth probing: each declared pattern, root, and paths just below/outside them. */
export function probePaths(d: RawDecl): string[] {
  const set = new Set<string>(["/", "/zzz", "/other/page"]);
  for (const p of d.paths ?? []) {
    const n = norm(p.pattern);
    set.add(n);
    set.add(`${n}x/y`);
    set.add(`${n}deeper/`);
  }
  return [...set];
}

/** Scopes: root + each declared pattern (path `/` represents root). */
export function scopePaths(d: RawDecl): string[] {
  return ["/", ...(d.paths ?? []).map((p) => norm(p.pattern))];
}

/* ── parsers ──────────────────────────────────────────────────────── */

export function parseKv(value: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const [k, v] = part.trim().split(sep);
    if (k && v) out[k] = v;
  }
  return out;
}

export type Group = { agents: string[]; lines: Array<[string, string]> };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasUa = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasUa) {
        cur = { agents: [], lines: [] };
        groups.push(cur);
      }
      cur.agents.push(val);
      lastWasUa = true;
    } else if (field === "license") {
      lastWasUa = false;
    } else if (cur) {
      cur.lines.push([field, val]);
      lastWasUa = false;
    }
  }
  return groups;
}

export type RslContent = { path: string; permits: string[]; prohibits: string[] };
export function parseRsl(xml: string | null): RslContent[] {
  if (!xml) return [];
  const out: RslContent[] = [];
  for (const m of xml.matchAll(/<content url="https:\/\/[^/"]+([^"]*)">([\s\S]*?)<\/content>/g)) {
    const expand = (re: RegExp): string[] => {
      const t = [...m[2]!.matchAll(re)].flatMap((x) => x[1]!.split(","));
      return t.flatMap((x) => (x === "all" ? ["ai-train", "ai-input", "search"] : [x]));
    };
    out.push({
      path: m[1]!.replace(/\*$/, ""),
      permits: expand(/<permits type="usage">([^<]*)<\/permits>/g),
      prohibits: expand(/<prohibits type="usage">([^<]*)<\/prohibits>/g),
    });
  }
  return out;
}

export function parseAiTxt(text: string): Array<{ scope: string; lines: Array<[string, string]> }> {
  const out: Array<{ scope: string; lines: Array<[string, string]> }> = [];
  let cur: { scope: string; lines: Array<[string, string]> } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (k === "Scope") {
      cur = { scope: v, lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push([k, v]);
  }
  return out;
}
