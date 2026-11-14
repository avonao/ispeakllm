// Validates the conformance fixtures against every JSON schema in spec/. A small built-in validator
// (the subset these schemas use) keeps the repo free of a schema dependency.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentHandler, type Bundle, type FetchEvent } from "../src/index";
import { generateKeyPair, signManifest } from "@ispeakllm/sign";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

type Schema = Record<string, any>;
export function validate(schema: Schema, v: unknown, at = "$", rootSchema: Schema = schema): string[] {
  const errs: string[] = [];
  if (schema.$ref) {
    const ref = String(schema.$ref).replace(/^#\//, "").split("/");
    let s: any = rootSchema;
    for (const k of ref) s = s?.[k];
    return s ? validate(s, v, at, rootSchema) : [`${at}: unresolved $ref ${schema.$ref}`];
  }
  if ("const" in schema && JSON.stringify(v) !== JSON.stringify(schema.const)) errs.push(`${at}: not const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!types.some((x: string) => x === t || (x === "number" && (t === "integer" || t === "number")))) return [...errs, `${at}: type ${t}, want ${types.join("|")}`];
  }
  for (const k of ["anyOf", "oneOf"]) if (schema[k] && !schema[k].some((s: Schema) => validate(s, v, at, rootSchema).length === 0)) errs.push(`${at}: matches no ${k} branch`);
  if (schema.allOf) for (const s of schema.allOf) errs.push(...validate(s, v, at, rootSchema));
  if (typeof v === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(v)) errs.push(`${at}: !~ ${schema.pattern}`);
    if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${at}: too long`);
  }
  if (typeof v === "number" && schema.minimum !== undefined && v < schema.minimum) errs.push(`${at}: < minimum`);
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`, rootSchema)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${at}: missing ${r}`);
    for (const [k, x] of Object.entries(o)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], x, `${at}.${k}`, rootSchema));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, x, `${at}.${k}`, rootSchema));
    }
  }
  return errs;
}

describe("spec schemas validate the conformance fixtures", () => {
  it("bundle", () => {
    expect(validate(json("spec/bundle/bundle.schema.json"), json("conformance/adapter-http/bundle.json"))).toEqual([]);
  });
  it("declaration", () => {
    const schema = json("spec/declaration/declaration.schema.json");
    for (const d of readdirSync(join(root, "conformance")).filter((x) => x.startsWith("policy-"))) {
      expect(validate(schema, json(`conformance/${d}/declaration.json`)), d).toEqual([]);
    }
    expect(validate(schema, json("examples/basic-site/declaration.json"))).toEqual([]);
  });
  it("fetch log records produced by serve", async () => {
    const events: FetchEvent[] = [];
    const h = createAgentHandler({ bundle: json("conformance/adapter-http/bundle.json") as Bundle, fetchLog: { ipSalt: "spec-test-salt-0123" }, onFetch: (e) => void events.push(e) });
    await h.handle(new Request("https://acme.example/llms.txt", { headers: { "user-agent": "GPTBot/1.2", "cf-connecting-ip": "192.0.2.1" } }));
    expect(validate(json("spec/fetch-log/fetch-log.schema.json"), JSON.parse(JSON.stringify(events[0]!.record)))).toEqual([]);
  });
  it("ACM, once signed, matches the ACM schema", async () => {
    const shell = JSON.parse((json("conformance/adapter-http/bundle.json") as Bundle).files["/.well-known/ai-conformance.json"]!.body);
    const pair = await generateKeyPair();
    const signed = await signManifest(shell, pair.privateKey, { signedAt: "2026-11-14T00:00:00Z" });
    expect(validate(json("spec/acm/acm.schema.json"), JSON.parse(JSON.stringify(signed)))).toEqual([]);
  });
  it("the validator rejects bad input", () => {
    expect(validate(json("spec/bundle/bundle.schema.json"), { version: 2, files: {} }).length).toBeGreaterThan(0);
  });
});
