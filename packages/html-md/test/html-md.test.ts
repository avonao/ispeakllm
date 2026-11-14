import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { convertHtml } from "../src/index";

const f = (n: string) => readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), "utf8");

describe("html-md fallback", () => {
  it("docs: keeps main content, drops nav/footer/scripts, always fallback", () => {
    const r = convertHtml(f("docs"), { baseUrl: "https://ex.com/docs/install" });
    expect(r.fallback).toBe(true);
    expect(r.markdown).toContain("# Install guide");
    expect(r.markdown).toContain("`npm i foo`");
    expect(r.markdown).toContain("**install**");
    expect(r.markdown).toContain("[the API](https://ex.com/api)");
    expect(r.markdown).toContain("1. Download");
    expect(r.markdown).toContain("  - fast");
    expect(r.markdown).toContain("```bash");
    expect(r.markdown).toContain("| Flag | Meaning |");
    expect(r.markdown).toContain('"@type":"TechArticle"');
    expect(r.markdown).toContain("source: html-fallback");
    for (const bad of ["Home", "© 2026", "alert(1)", ".x{}"]) expect(r.markdown).not.toContain(bad);
  });
  it("blog: drops cookie banner, decodes entities, keeps image alt", () => {
    const r = convertHtml(f("blog"));
    expect(r.markdown).toContain("First & best. *Really*.");
    expect(r.markdown).toContain("> Quote here");
    expect(r.markdown).toContain("![A pic](/a.png)");
    expect(r.markdown).not.toContain("Accept cookies");
    expect(r.markdown).not.toContain("Menu");
  });
  it("shop: no body main, buttons/forms dropped", () => {
    const r = convertHtml(f("shop"));
    expect(r.markdown).toContain("# Blue Mug");
    expect(r.markdown).not.toContain("Buy");
  });
  it("marketing: og metadata into frontmatter", () => {
    const r = convertHtml(f("marketing"), { baseUrl: "https://ex.com/" });
    expect(r.markdown).toContain('title: "Acme Cloud"');
    expect(r.markdown).toContain('image: "https://ex.com/hero.png"');
    expect(r.markdown).toContain("Speed.");
  });
  it("spa shell: empty body gives empty-ish output, no crash", () => {
    const r = convertHtml(f("spa"), { frontmatter: false });
    expect(r.markdown.trim()).toBe("");
  });
  it("is deterministic", () => {
    expect(convertHtml(f("docs")).markdown).toBe(convertHtml(f("docs")).markdown);
  });
});
