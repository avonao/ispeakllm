// Ported from runtime/emissary/test/declaration.test.ts (trustvice-v3-2026-11-10-current), rewritten for the v1 model.
import { describe, it, expect } from "vitest";
import {
  composeDeclaration,
  validateDeclaration,
  canonicalDeclaration,
  parseDeclaration,
  DeclarationError,
  silentSubjects,
  stanceFor,
} from "../src/index";

const base = { domain: "Example.com", defaults: [{ subject: "train", stance: "deny" }] };
const codes = (input: unknown): string[] => {
  const r = validateDeclaration(input);
  return r.ok ? [] : r.errors.map((e) => e.code);
};

describe("validation rejects invalid declarations", () => {
  it("rejects non-objects", () => expect(codes(null)).toEqual(["not_an_object"]));
  it("rejects a missing domain", () => expect(codes({ defaults: base.defaults })).toContain("no_domain"));
  it("rejects a domain with a scheme or path", () => {
    expect(codes({ ...base, domain: "https://example.com" })).toContain("invalid_domain");
    expect(codes({ ...base, domain: "example.com/blog" })).toContain("invalid_domain");
  });
  it("rejects a declaration with no directives", () => expect(codes({ domain: "a.example", defaults: [] })).toContain("no_directives"));
  it("rejects a missing defaults array", () => expect(codes({ domain: "a.example" })).toContain("no_directives"));
  it("rejects an unknown subject and stance", () => {
    expect(codes({ ...base, defaults: [{ subject: "scrape", stance: "deny" }] })).toContain("invalid_subject");
    expect(codes({ ...base, defaults: [{ subject: "train", stance: "maybe" }] })).toContain("invalid_stance");
  });
  it("rejects two stances on one subject", () => {
    expect(codes({ ...base, defaults: [{ subject: "train", stance: "deny" }, { subject: "train", stance: "allow" }] })).toContain("duplicate_subject");
  });
  it("rejects a conditional with no or an empty condition", () => {
    expect(codes({ ...base, defaults: [{ subject: "infer", stance: "conditional" }] })).toContain("conditional_without_condition");
    expect(codes({ ...base, defaults: [{ subject: "infer", stance: "conditional", condition: "  " }] })).toContain("empty_condition");
  });
  it("rejects a condition on allow/deny", () => {
    expect(codes({ ...base, defaults: [{ subject: "infer", stance: "allow", condition: "x" }] })).toContain("condition_on_non_conditional");
  });
  it("rejects a multi-line condition (it would break robots.txt and XML)", () => {
    expect(codes({ ...base, defaults: [{ subject: "infer", stance: "conditional", condition: "a\nDisallow: /" }] })).toContain("invalid_text");
  });
  it("rejects bad, root and duplicate paths", () => {
    const ov = (pattern: string) => ({ ...base, paths: [{ pattern, directives: [{ subject: "train", stance: "allow" }] }] });
    expect(codes(ov("blog"))).toContain("invalid_path");
    expect(codes(ov("/a b/"))).toContain("invalid_path");
    expect(codes(ov("/a/*/b"))).toContain("invalid_path");
    expect(codes(ov("/*"))).toContain("path_is_root");
    expect(codes({ ...base, paths: [...ov("/a/").paths, ...ov("/a/*").paths] })).toContain("duplicate_path");
  });
  it("rejects bad and duplicate agents and empty overrides", () => {
    const ag = (agent: string, directives = [{ subject: "train", stance: "deny" }]) => ({ agent, directives });
    expect(codes({ ...base, agents: [ag("*")] })).toContain("invalid_agent");
    expect(codes({ ...base, agents: [ag("__usage_ai-training")] })).toContain("invalid_agent");
    expect(codes({ ...base, agents: [ag("GPTBot"), ag("gptbot")] })).toContain("duplicate_agent");
    expect(codes({ ...base, agents: [ag("GPTBot", [])] })).toContain("empty_override");
  });
  it("reports every problem, not just the first", () => {
    expect(codes({ domain: "", defaults: [{ subject: "x", stance: "y" }] }).length).toBeGreaterThanOrEqual(3);
  });
  it("parseDeclaration throws a typed error", () => {
    expect(() => parseDeclaration({})).toThrow(DeclarationError);
  });
});

describe("canonical form", () => {
  const input = {
    domain: "Example.COM",
    defaults: [{ subject: "train", stance: "deny" }, { subject: "index", stance: "allow" }],
    paths: [
      { pattern: "/b/*", directives: [{ subject: "train", stance: "allow" }] },
      { pattern: "/a/", directives: [{ subject: "train", stance: "allow" }] },
    ],
  };

  it("lowercases the domain, sorts directives and paths, normalises patterns", async () => {
    const r = await composeDeclaration(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declaration.domain).toBe("example.com");
    expect(r.declaration.defaults.map((x) => x.subject)).toEqual(["index", "train"]);
    expect(r.declaration.paths.map((p) => p.pattern)).toEqual(["/a/", "/b/"]);
  });

  it("yields the same id for the same declaration regardless of input order", async () => {
    const a = await composeDeclaration(input);
    const b = await composeDeclaration({
      ...input,
      defaults: [...input.defaults].reverse(),
      paths: [...input.paths].reverse(),
    });
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    if (a.ok) expect(a.id).toMatch(/^emd_[A-Za-z0-9_-]{43}$/);
  });

  it("a one-word change gives a different id", async () => {
    const a = await composeDeclaration(input);
    const b = await composeDeclaration({ ...input, defaults: [{ subject: "train", stance: "allow" }, { subject: "index", stance: "allow" }] });
    expect(a.ok && b.ok && a.id !== b.id).toBe(true);
  });

  it("canonical JSON has sorted keys and no whitespace", () => {
    const d = parseDeclaration(input);
    const c = canonicalDeclaration(d);
    expect(c.startsWith('{"agents":[],"contact":null,')).toBe(true);
    expect(c).not.toMatch(/\s/);
  });
});

describe("silence is surfaced, not defaulted", () => {
  it("lists the subjects not declared", () => {
    const d = parseDeclaration(base);
    expect(silentSubjects(d.defaults)).toEqual(["index", "infer", "quote", "embed", "evaluate"]);
    expect(stanceFor(d.defaults, "index")).toBeNull();
    expect(stanceFor(d.defaults, "train")?.stance).toBe("deny");
  });
});
