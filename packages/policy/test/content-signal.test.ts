// Ported from runtime/emissary/test/content-signal.test.ts (trustvice-v3-2026-11-10-current)
import { describe, it, expect } from "vitest";
import { axisValue, contentSignalHeader, CONTENT_SIGNAL_AXES, type Directive } from "../src/index";

const d = (subject: Directive["subject"], stance: Directive["stance"], condition?: string): Directive =>
  ({ subject, stance, ...(condition ? { condition } : {}) });

describe("axisValue: conservative reduction", () => {
  it("omits an axis when every contributing subject is silent", () => {
    expect(axisValue([d("index", "allow")], "ai-train")).toBeNull();
    expect(axisValue([], "search")).toBeNull();
  });

  it("says yes only when every contributor is an unconditional allow", () => {
    expect(axisValue([d("index", "allow")], "search")).toBe("yes");
    expect(axisValue([d("train", "allow"), d("evaluate", "allow")], "ai-train")).toBe("yes");
  });

  it("says no when any contributor denies", () => {
    expect(axisValue([d("train", "allow"), d("evaluate", "deny")], "ai-train")).toBe("no");
  });

  it("collapses a conditional to no: the header cannot carry the condition", () => {
    expect(axisValue([d("infer", "conditional", "attribution required")], "ai-input")).toBe("no");
  });

  it("never over-permits: one deny among allows on the same axis wins", () => {
    expect(axisValue([d("infer", "allow"), d("quote", "allow"), d("embed", "deny")], "ai-input")).toBe("no");
  });
});

describe("contentSignalHeader", () => {
  it("emits axes in canonical order, omitting the silent ones", () => {
    expect(contentSignalHeader([d("index", "allow"), d("train", "deny")])).toBe("search=yes, ai-train=no");
  });

  it("returns null when the declaration is silent on all three axes", () => {
    expect(contentSignalHeader([])).toBeNull();
  });

  it("covers all three axes when fully specified", () => {
    const header = contentSignalHeader([d("index", "allow"), d("infer", "allow"), d("train", "deny")]);
    expect(header).toBe("search=yes, ai-input=yes, ai-train=no");
    for (const axis of CONTENT_SIGNAL_AXES) expect(header).toContain(axis);
  });
});
