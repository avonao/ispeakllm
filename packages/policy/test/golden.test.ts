// New for iSpeakLLM. Golden files for three fixture policies (permissive,
// restrictive, conditional/mixed) under conformance/policy-*/. Regenerate with
// UPDATE_GOLDEN=1 and review the diff by hand.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeDeclaration, renderPolicySet, scopesOf, type PolicySet } from "../src/index";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../conformance");
const FIXTURES = ["policy-permissive", "policy-restrictive", "policy-mixed"] as const;
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function aiprefGolden(ps: PolicySet): string {
  const L: string[] = ["# IETF AIPREF projections (draft-ietf-aipref-vocab-08, draft-ietf-aipref-attach-05)", "", "## Content-Usage response header, per scope"];
  for (const s of scopesOf(ps.declaration)) {
    const p = s.pattern ?? "/";
    const v = ps.headersFor(p)["Content-Usage"];
    L.push(`${p}  ->  ${v ? `Content-Usage: ${v}` : "(no header: silent)"}`);
  }
  L.push("", "## robots.txt rules");
  let inScope = false;
  for (const l of ps.robotsTxt.split("\n")) {
    if (/^User-Agent:/i.test(l)) inScope = /^User-Agent: (\*|__usage_ai-training)$/i.test(l);
    if (inScope && /^(User-Agent:|Content-Usage:|Allow:|Disallow:)/i.test(l)) L.push(l);
  }
  return L.join("\n") + "\n";
}

function check(file: string, actual: string): void {
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `${file} missing: run with UPDATE_GOLDEN=1`).toBe(true);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

describe("golden policy outputs", () => {
  for (const name of FIXTURES) {
    describe(name, async () => {
      const dir = join(ROOT, name);
      const input = JSON.parse(readFileSync(join(dir, "declaration.json"), "utf8"));
      const composed = await composeDeclaration(input);
      if (!composed.ok) throw new Error(JSON.stringify(composed.errors));
      const ps = renderPolicySet(composed.declaration, { id: composed.id });

      it("robots.txt", () => check(join(dir, "robots.txt"), ps.robotsTxt));
      it("RSL 1.0 XML", () => check(join(dir, "rsl.xml"), ps.rslXml ?? ""));
      it("AIPREF", () => check(join(dir, "aipref.txt"), aiprefGolden(ps)));
      it("ai.txt", () => check(join(dir, "ai.txt"), ps.aiTxt));
      it("headers and TDM", () => {
        const out = {
          id: composed.id,
          headers: Object.fromEntries(scopesOf(ps.declaration).map((s) => [s.pattern ?? "/", ps.headersFor(s.pattern ?? "/")])),
          tdmrep: ps.tdmrepJson ? JSON.parse(ps.tdmrepJson) : null,
          notes: ps.notes,
        };
        check(join(dir, "headers.json"), JSON.stringify(out, null, 2) + "\n");
      });
      it("is byte-identical on a second render", () => {
        const again = renderPolicySet(JSON.parse(JSON.stringify(composed.declaration)), { id: composed.id });
        expect(again.artifacts).toEqual(ps.artifacts);
      });
    });
  }
});
