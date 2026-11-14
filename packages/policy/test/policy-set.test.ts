import { describe, it, expect } from "vitest";
import {
  DeclarationError,
  SIGNAL_CALENDAR,
  buildTdmEvidence,
  parseDeclaration,
  renderPolicySet,
  resolveStance,
  signalCalendar,
  signalStatus,
  type DeclarationInput,
} from "../src/index";

const decl = (o: Partial<DeclarationInput> & Pick<DeclarationInput, "defaults">): DeclarationInput => ({ domain: "t.example", ...o });

describe("silence emits nothing", () => {
  const ps = renderPolicySet(decl({ defaults: [{ subject: "index", stance: "allow" }] }));

  it("states only the search axis everywhere", () => {
    expect(ps.headers).toEqual({ "Content-Signal": "search=yes", "Content-Usage": "search=y" });
    expect(ps.robotsTxt).toContain("Content-Signal: search=yes");
    expect(ps.robotsTxt).not.toMatch(/ai-train|ai-input|train-ai|ai-use/);
  });
  it("writes no training token, no crawler group, no TDM, no AI terms", () => {
    expect(ps.robotsTxt).not.toContain("__usage_ai-training");
    expect(ps.robotsTxt).not.toMatch(/User-agent: (GPTBot|ClaudeBot|ChatGPT-User)/i);
    expect(ps.tdmrepJson).toBeNull();
    expect(ps.headers["tdm-reservation"]).toBeUndefined();
    expect(ps.rslXml).toContain('<permits type="usage">search</permits>');
    expect(ps.rslXml).not.toMatch(/ai-train|ai-input|all</);
    expect(ps.aiTxt).not.toMatch(/TDM-Reservation|train-ai/);
    expect(ps.artifacts.map((a) => a.path)).toEqual(["/robots.txt", "/license.xml", "/ai.txt"]);
  });
  it("a declaration silent on search emits no search anywhere", () => {
    const p = renderPolicySet(decl({ defaults: [{ subject: "train", stance: "deny" }] }));
    expect(p.headers["Content-Signal"]).toBe("ai-train=no");
    expect(p.rslXml).not.toContain("search");
  });
});

describe("projections", () => {
  it("conditional never reads as yes", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "infer", stance: "conditional", condition: "attribution" }] }));
    expect(ps.headers["Content-Signal"]).toBe("ai-input=no");
    expect(ps.rslXml).toContain('<prohibits type="usage">ai-input</prohibits>');
    expect(ps.rslXml).toContain("attribution");
  });
  it("denied training writes the training token, crawler blocks and a reserved TDM header", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "train", stance: "deny" }] }));
    expect(ps.robotsTxt).toContain("User-Agent: __usage_ai-training\nDisallow: /");
    for (const ua of ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Applebot-Extended", "Bytespider", "meta-externalagent"]) {
      expect(ps.robotsTxt).toContain(`User-agent: ${ua}\nDisallow: /`);
    }
    expect(ps.robotsTxt).not.toContain("User-agent: ChatGPT-User");
    expect(ps.headers["tdm-reservation"]).toBe("1");
    expect(JSON.parse(ps.tdmrepJson!)).toEqual([{ location: "/*", "tdm-reservation": 1 }]);
  });
  it("a denied infer blocks the user-triggered agents only", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "infer", stance: "deny" }] }));
    expect(ps.robotsTxt).toContain("User-agent: ChatGPT-User\nDisallow: /");
    expect(ps.robotsTxt).toContain("User-agent: Claude-User\nDisallow: /");
    expect(ps.robotsTxt).not.toContain("User-agent: GPTBot");
  });
  it("carries tdm-policy and a RSL License line when given", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "train", stance: "deny" }] }), { tdmPolicyUrl: "https://t.example/tdm.json" });
    expect(ps.headers["tdm-policy"]).toBe("https://t.example/tdm.json");
    expect(ps.robotsTxt).toContain("License: https://t.example/license.xml");
  });
  it("a per-agent deny writes a group even for an agent outside the registry", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "index", stance: "allow" }], agents: [{ agent: "AcmeBot", directives: [{ subject: "train", stance: "deny" }] }] }));
    expect(ps.robotsTxt).toContain("User-agent: AcmeBot\nDisallow: /");
  });
  it("a loosening agent override is not projected and is explained", () => {
    const ps = renderPolicySet(decl({ defaults: [{ subject: "train", stance: "deny" }], agents: [{ agent: "GPTBot", directives: [{ subject: "train", stance: "allow" }] }] }));
    expect(ps.robotsTxt).toContain("User-agent: GPTBot\nDisallow: /");
    expect(ps.notes.join(" ")).toContain('Agent "GPTBot"');
  });
  it("throws a typed error for an invalid declaration", () => {
    expect(() => renderPolicySet({ domain: "t.example", defaults: [] })).toThrow(DeclarationError);
  });
});

describe("resolveStance (runtime)", () => {
  const d = parseDeclaration(decl({
    defaults: [{ subject: "quote", stance: "deny" }, { subject: "train", stance: "allow" }],
    paths: [{ pattern: "/docs/", directives: [{ subject: "quote", stance: "allow" }] }],
    agents: [
      { agent: "Claude-User", directives: [{ subject: "quote", stance: "allow" }] },
      { agent: "GPTBot", directives: [{ subject: "train", stance: "deny" }] },
    ],
  }));
  it("uses the longest declared prefix", () => {
    expect(resolveStance(d, "quote", { path: "/docs/intro" })?.stance).toBe("allow");
    expect(resolveStance(d, "quote", { path: "/blog/x" })?.stance).toBe("deny");
  });
  it("a loosening override needs a VERIFIED identity", () => {
    expect(resolveStance(d, "quote", { agent: "Claude-User" })?.stance).toBe("deny");
    expect(resolveStance(d, "quote", { agent: "claude-user", verified: true })?.stance).toBe("allow");
  });
  it("a restrictive override applies even when unverified", () => {
    expect(resolveStance(d, "train", { agent: "GPTBot" })?.stance).toBe("deny");
    expect(resolveStance(d, "train", {})?.stance).toBe("allow");
  });
  it("silence stays null", () => expect(resolveStance(d, "embed", {})).toBeNull());
});

describe("signal calendar", () => {
  it("records the four vendors as stated on 10 Nov 2026", () => {
    expect(SIGNAL_CALENDAR.map((e) => e.vendor)).toEqual(["Google", "Microsoft", "OpenAI", "Anthropic"]);
    expect(SIGNAL_CALENDAR.find((e) => e.vendor === "Microsoft")?.effectiveDate).toBe("2027-02-01");
    expect(SIGNAL_CALENDAR.find((e) => e.vendor === "Google")?.timing).toBe("early 2027");
    expect(SIGNAL_CALENDAR.find((e) => e.vendor === "OpenAI")?.scope).toBe("foundational training");
    expect(SIGNAL_CALENDAR.find((e) => e.vendor === "Anthropic")?.status).toBe("rolling-out");
  });
  it("a dated entry becomes effective only on its date", () => {
    const ms = SIGNAL_CALENDAR.find((e) => e.vendor === "Microsoft")!;
    expect(signalStatus(ms, "2027-01-31T23:59:59Z")).toBe("scheduled");
    expect(signalStatus(ms, "2027-02-01T00:00:00Z")).toBe("effective");
    expect(signalCalendar("2026-11-14T00:00:00Z").find((e) => e.vendor === "Google")?.currentStatus).toBe("announced");
  });
});

describe("TDM evidence", () => {
  const window = { from: "2026-01-01T00:00:00Z", to: "2026-07-01T00:00:00Z" };
  const v = (format: "robots-txt" | "tdmrep" | "rsl", version: string, from: string, to: string | null, reservation: "reserved" | "unknown" = "reserved") =>
    ({ format, version, contentHash: `h${version}`, from, to, reservation }) as const;

  const ev = buildTdmEvidence({
    domain: "T.example",
    window,
    nowIso: "2026-11-14T00:00:00Z",
    versions: [
      v("robots-txt", "1", "2025-12-01T00:00:00Z", "2026-03-01T00:00:00Z"),
      v("robots-txt", "2", "2026-03-01T00:00:00Z", null),
      v("tdmrep", "1", "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z", "unknown"),
    ],
    deliveries: [
      { id: "f1", format: "robots-txt", at: "2026-02-01T00:00:00Z", status: 200, grade: "verified" },
      { id: "f2", format: "robots-txt", at: "2026-02-02T00:00:00Z", status: 304, grade: "unauthenticated" },
      { id: "f3", format: "robots-txt", at: "2026-05-01T00:00:00Z", status: 500, grade: "unauthenticated" },
    ],
  });

  it("clamps coverage to the window and keeps open-ended versions open", () => {
    const r = ev.coverage.filter((c) => c.format === "robots-txt");
    expect(r[0]).toMatchObject({ version: "1", from: "2026-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" });
    expect(r[1]).toMatchObject({ version: "2", to: null });
  });
  it("reports a gap instead of smoothing it over", () => {
    expect(ev.gaps.filter((g) => g.format === "tdmrep")).toEqual([
      { format: "tdmrep", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", reason: "No version of this format was in effect." },
      { format: "tdmrep", from: "2026-04-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z", reason: "No version of this format was in effect." },
    ]);
    expect(ev.gaps.filter((g) => g.format === "robots-txt")).toEqual([]);
  });
  it("keeps an unreadable version as `unknown`", () => {
    expect(ev.coverage.find((c) => c.format === "tdmrep")?.reservation).toBe("unknown");
  });
  it("counts deliveries separately, by grade, and carries contradicting fetches", () => {
    expect(ev.served).toEqual([{ format: "robots-txt", delivered: 2, firstAt: "2026-02-01T00:00:00.000Z", lastAt: "2026-02-02T00:00:00.000Z", byGrade: { unauthenticated: 1, verified: 1 } }]);
    expect(ev.contradictingFetches.map((f) => f.id)).toEqual(["f3"]);
  });
  it("lists formats with no version, and states its claim boundary", () => {
    expect(ev.formatsNeverPublished).toContain("rsl");
    expect(ev.formatsNeverPublished).not.toContain("robots-txt");
    expect(ev.claimBoundary).toContain("no claim about whether any third party trained");
    expect(ev.domain).toBe("t.example");
  });
  it("rejects an inverted window", () => {
    expect(() => buildTdmEvidence({ domain: "a", window: { from: window.to, to: window.from }, versions: [], nowIso: "x" })).toThrow(RangeError);
  });
});
