// New for IspeakLLM. PROPERTY TEST: no projection is ever more permissive than
// the declaration. Fast-check-free: a seeded generator produces >= 500 random
// declarations; an independent oracle (oracle.ts) parses the RENDERED output.
import { describe, it, expect } from "vitest";
import { renderPolicySet } from "../src/index";
import {
  ALL_AI, INPUT, SEARCH, TRAIN,
  agentStancesAt, anyDeclared, canPermit, parseAiTxt, parseKv, parseRobots, parseRsl, probePaths, scopePaths, stancesAt,
  type Dir, type RawDecl, type Stn, type Subj,
} from "./oracle";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS: Subj[] = ["index", "infer", "quote", "embed", "train", "evaluate"];
const PATH_POOL = ["/a/", "/a/b/", "/c/", "/d/e", "/a/b/c/", "/c/*"];
const AGENT_POOL = ["GPTBot", "ClaudeBot", "Claude-User", "OAI-SearchBot", "Google-Extended", "ExampleBot", "OtherBot"];

function genDirectives(rnd: () => number, pSilent: number, atLeastOne: boolean): Dir[] {
  const out: Dir[] = [];
  for (const s of SUBJECTS) {
    if (rnd() < pSilent) continue;
    const r = rnd();
    const stance: Stn = r < 0.4 ? "allow" : r < 0.75 ? "deny" : "conditional";
    out.push(stance === "conditional" ? { subject: s, stance, condition: `cond ${s}` } : { subject: s, stance });
  }
  if (atLeastOne && out.length === 0) out.push({ subject: SUBJECTS[Math.floor(rnd() * 6)]!, stance: "allow" });
  return out;
}

function genDecl(rnd: () => number): RawDecl {
  const paths: NonNullable<RawDecl["paths"]> = [];
  const used = new Set<string>();
  const nPaths = Math.floor(rnd() * 4);
  for (let i = 0; i < nPaths; i++) {
    const p = PATH_POOL[Math.floor(rnd() * PATH_POOL.length)]!;
    const key = p.replace(/\*$/, "");
    if (used.has(key)) continue;
    used.add(key);
    paths.push({ pattern: p, directives: genDirectives(rnd, 0.6, true) });
  }
  const agents: NonNullable<RawDecl["agents"]> = [];
  const usedA = new Set<string>();
  const nAgents = Math.floor(rnd() * 4);
  for (let i = 0; i < nAgents; i++) {
    const a = AGENT_POOL[Math.floor(rnd() * AGENT_POOL.length)]!;
    if (usedA.has(a.toLowerCase())) continue;
    usedA.add(a.toLowerCase());
    agents.push({ agent: a, directives: genDirectives(rnd, 0.6, true) });
  }
  return { domain: "gen.example", defaults: genDirectives(rnd, 0.35, true), paths, agents };
}

const CS_SUBJECTS = { search: SEARCH, "ai-input": INPUT, "ai-train": TRAIN } as const;

function checkCase(d: RawDecl, label: string): string[] {
  const bad: string[] = [];
  const fail = (m: string) => bad.push(`${label}: ${m}`);
  const ps = renderPolicySet(d);
  const probes = probePaths(d);
  const scopes = scopePaths(d);

  // 1. Response headers, per probed path.
  for (const p of probes) {
    const s = stancesAt(d, p);
    const h = ps.headersFor(p);
    const cs = h["Content-Signal"] ? parseKv(h["Content-Signal"], "=") : {};
    for (const [axis, subs] of Object.entries(CS_SUBJECTS)) {
      const present = axis in cs;
      if (present !== anyDeclared(s, [...subs])) fail(`Content-Signal ${axis} presence mismatch at ${p}`);
      if (cs[axis] === "yes" && !canPermit(s, [...subs], "contributors")) fail(`Content-Signal ${axis}=yes too permissive at ${p}`);
    }
    const cu = h["Content-Usage"] ? parseKv(h["Content-Usage"], "=") : {};
    if (cu["train-ai"] === "y" && !canPermit(s, TRAIN, "contributors")) fail(`train-ai=y at ${p}`);
    if (cu["search"] === "y" && !canPermit(s, SEARCH, "contributors")) fail(`search=y at ${p}`);
    if (cu["ai-use"] === "y" && !canPermit(s, ALL_AI, "declared-all")) fail(`ai-use=y at ${p}`);
    if (("train-ai" in cu) !== anyDeclared(s, TRAIN)) fail(`train-ai presence at ${p}`);
    if (("search" in cu) !== anyDeclared(s, SEARCH)) fail(`search presence at ${p}`);
    if (cu["ai-use"] === "n" && ALL_AI.some((x) => s[x] === "allow")) fail(`ai-use=n while something is allowed at ${p}`);
    const tdm = h["tdm-reservation"];
    if (tdm === "0" && !canPermit(s, TRAIN, "contributors")) fail(`tdm-reservation 0 at ${p}`);
    if ((tdm !== undefined) !== anyDeclared(s, TRAIN)) fail(`tdm-reservation presence at ${p}`);
  }

  // 2. robots.txt.
  const groups = parseRobots(ps.robotsTxt);
  for (const g of groups) {
    const isStar = g.agents.length === 1 && g.agents[0] === "*";
    const isToken = g.agents.length === 1 && g.agents[0] === "__usage_ai-training";
    if (g.agents.includes("*") && !isStar) fail("`*` mixed into another group");
    for (const [field, val] of g.lines) {
      if (isStar) {
        if (field === "allow") fail("`*` group carries an Allow rule");
        if (field === "content-signal") {
          const kv = parseKv(val, "=");
          for (const [axis, subs] of Object.entries(CS_SUBJECTS)) {
            if (kv[axis] === "yes") for (const sc of scopes) if (!canPermit(stancesAt(d, sc), [...subs], "contributors")) fail(`robots Content-Signal ${axis}=yes but not allowed at ${sc}`);
          }
        }
        if (field === "content-usage") {
          const m = /^(\/\S*)\s+(.*)$/.exec(val);
          const sc = m ? m[1]! : "/";
          const kv = parseKv(m ? m[2]! : val, "=");
          const s = stancesAt(d, sc);
          if (kv["train-ai"] === "y" && !canPermit(s, TRAIN, "contributors")) fail(`robots train-ai=y at ${sc}`);
          if (kv["search"] === "y" && !canPermit(s, SEARCH, "contributors")) fail(`robots search=y at ${sc}`);
          if (kv["ai-use"] === "y" && !canPermit(s, ALL_AI, "declared-all")) fail(`robots ai-use=y at ${sc}`);
        }
      } else if (field === "allow") {
        const sc = val === "/" ? "/" : val;
        for (const t of g.agents) {
          if (isToken) {
            if (!canPermit(stancesAt(d, sc), TRAIN, "contributors")) fail(`token Allow ${sc} but training not allowed`);
          } else {
            // An Allow for a user agent is only a carve-out of a declared block: its subjects must all be allow there.
            const subj = agentSubjects(t, d);
            if (!canPermit(agentStancesAt(d, sc, t), subj, "contributors")) fail(`${t} Allow ${sc} but not declared allow`);
          }
        }
      }
    }
    // Silence: a user-agent/token group only exists if something it serves is declared.
    if (!isStar) {
      for (const t of g.agents) {
        const subj = isToken ? TRAIN : agentSubjects(t, d);
        if (!scopes.some((sc) => anyDeclared(isToken ? stancesAt(d, sc) : agentStancesAt(d, sc, t), subj))) fail(`group for ${t} but the declaration is silent`);
      }
    }
  }
  // Loosening-only agent overrides never create a group on their own.
  for (const a of d.agents ?? []) {
    const restrictive = a.directives.some((x) => x.stance !== "allow");
    const groupExists = groups.some((g) => g.agents.some((t) => t.toLowerCase() === a.agent.toLowerCase()));
    if (!restrictive && groupExists) {
      const registered = ["gptbot", "oai-searchbot", "chatgpt-user", "claudebot", "claude-searchbot", "claude-user", "google-extended", "perplexitybot", "ccbot", "applebot-extended", "bytespider", "meta-externalagent"].includes(a.agent.toLowerCase());
      const g = groups.find((x) => x.agents.some((t) => t.toLowerCase() === a.agent.toLowerCase()))!;
      // A registered crawler may still be blocked by the DEFAULT stances; an unregistered one must not appear.
      if (!registered) fail(`unregistered loosening-only agent ${a.agent} got a group`);
      else if (g.lines.some(([f]) => f === "allow") && !scopes.some((sc) => anyDeclared(stancesAt(d, sc), agentSubjects(a.agent, d)))) fail(`loosening-only agent ${a.agent} got an Allow`);
    }
  }

  // 3. RSL.
  const rsl = parseRsl(ps.rslXml);
  const rslScopes = new Set<string>();
  for (const c of rsl) {
    const p = c.path === "/" ? "/" : c.path;
    rslScopes.add(p);
    const s = stancesAt(d, p);
    for (const [term, subs] of [["ai-train", TRAIN], ["ai-input", INPUT], ["search", SEARCH]] as const) {
      if (c.permits.includes(term) && !canPermit(s, [...subs], "contributors")) fail(`RSL permits ${term} at ${p}`);
      const stated = c.permits.includes(term) || c.prohibits.includes(term);
      if (stated !== anyDeclared(s, [...subs])) fail(`RSL ${term} presence at ${p}`);
    }
  }
  for (const sc of scopes) {
    const s = stancesAt(d, sc);
    if (anyDeclared(s, ALL_AI) || anyDeclared(s, SEARCH)) {
      if (!rslScopes.has(sc)) fail(`RSL missing scope ${sc}`);
    }
  }

  // 4. ai.txt.
  for (const sec of parseAiTxt(ps.aiTxt)) {
    const s = stancesAt(d, sec.scope);
    for (const [k, v] of sec.lines) {
      if (k === "Allow-Use") for (const x of v.split(",").map((y) => y.trim())) if (s[x as Subj] !== "allow") fail(`ai.txt Allow-Use ${x} at ${sec.scope}`);
      if (k === "Disallow-Use") for (const x of v.split(",").map((y) => y.trim())) if (s[x as Subj] !== "deny") fail(`ai.txt Disallow-Use ${x} at ${sec.scope}`);
      if (k === "Conditional-Use") { const x = v.split(":")[0]!.trim(); if (s[x as Subj] !== "conditional") fail(`ai.txt Conditional-Use ${x} at ${sec.scope}`); }
      if (k === "Content-Signal") { const kv = parseKv(v, "="); for (const [axis, subs] of Object.entries(CS_SUBJECTS)) if (kv[axis] === "yes" && !canPermit(s, [...subs], "contributors")) fail(`ai.txt Content-Signal ${axis} at ${sec.scope}`); }
      if (k === "Content-Usage") { const kv = parseKv(v, "="); if (kv["train-ai"] === "y" && !canPermit(s, TRAIN, "contributors")) fail(`ai.txt train-ai at ${sec.scope}`); if (kv["ai-use"] === "y" && !canPermit(s, ALL_AI, "declared-all")) fail(`ai.txt ai-use at ${sec.scope}`); }
      if (k === "TDM-Reservation" && v === "0" && !canPermit(s, TRAIN, "contributors")) fail(`ai.txt TDM-Reservation 0 at ${sec.scope}`);
    }
    const declared = SUBJECTS.filter((x) => s[x] !== undefined);
    const listed = sec.lines.filter(([k]) => ["Allow-Use", "Disallow-Use", "Conditional-Use"].includes(k)).flatMap(([k, v]) => (k === "Conditional-Use" ? [v.split(":")[0]!.trim()] : v.split(",").map((y) => y.trim())));
    if (listed.sort().join() !== [...declared].sort().join()) fail(`ai.txt lists a different subject set at ${sec.scope}`);
  }

  // 5. tdmrep.json: first matching entry per probed path.
  const entries: Array<{ location: string; "tdm-reservation": number }> = ps.tdmrepJson ? JSON.parse(ps.tdmrepJson) : [];
  for (const p of probes) {
    const e = entries.find((x) => p.startsWith(x.location.replace(/\*$/, "")));
    const s = stancesAt(d, p);
    if (e && e["tdm-reservation"] === 0 && !canPermit(s, TRAIN, "contributors")) fail(`tdmrep 0 at ${p}`);
    if (e && !anyDeclared(s, TRAIN)) fail(`tdmrep entry for silent ${p}`);
    if (!e && anyDeclared(s, TRAIN)) fail(`tdmrep missing entry at ${p}`);
  }
  return bad;
}

const REGISTRY: Record<string, Subj[]> = {
  gptbot: ["train"], "oai-searchbot": ["index"], "chatgpt-user": ["infer"], claudebot: ["train"], "claude-searchbot": ["index"],
  "claude-user": ["infer"], "google-extended": ["train"], perplexitybot: ["index"], ccbot: ["train"], "applebot-extended": ["train"],
  bytespider: ["train"], "meta-externalagent": ["train"],
};
function agentSubjects(token: string, d: RawDecl): Subj[] {
  const r = REGISTRY[token.toLowerCase()];
  if (r) return r;
  return (d.agents ?? []).find((a) => a.agent.toLowerCase() === token.toLowerCase())?.directives.filter((x) => x.stance !== "allow").map((x) => x.subject) ?? [];
}

describe("property: no projection is ever more permissive than the declaration", () => {
  it("holds for 800 seeded random declarations", () => {
    const rnd = mulberry32(20261114);
    const failures: string[] = [];
    let withPaths = 0, withAgents = 0, withLoosening = 0;
    for (let i = 0; i < 800; i++) {
      const d = genDecl(rnd);
      if ((d.paths ?? []).length) withPaths++;
      if ((d.agents ?? []).length) withAgents++;
      if ((d.agents ?? []).some((a) => a.directives.some((x) => x.stance === "allow"))) withLoosening++;
      failures.push(...checkCase(d, `case ${i} ${JSON.stringify(d)}`));
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    // The generator really exercised the hard parts.
    expect(withPaths).toBeGreaterThan(300);
    expect(withAgents).toBeGreaterThan(300);
    expect(withLoosening).toBeGreaterThan(100);
  });

  it("the oracle can fail: a hand-made over-permissive projection is caught", () => {
    const d: RawDecl = { domain: "x.example", defaults: [{ subject: "train", stance: "deny" }] };
    const s = stancesAt(d, "/");
    expect(canPermit(s, TRAIN, "contributors")).toBe(false);
    const forged = parseKv("ai-train=yes", "=");
    expect(forged["ai-train"] === "yes" && !canPermit(s, TRAIN, "contributors")).toBe(true);
  });
});
