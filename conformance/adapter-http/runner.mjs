// Shared adapter conformance runner. Plain JS so every adapter (and every language port) can use it.
//   In-process:  import { runConformance } from "conformance/adapter-http/runner.mjs"; await runConformance(handler)
//   Over HTTP:   node conformance/adapter-http/runner.mjs http://127.0.0.1:8080 [--level core|full]
// The host behind the adapter must answer pass-through requests with HOST_BODY as text/html.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
export const BUNDLE = JSON.parse(readFileSync(join(here, CASES.bundle), "utf8"));
export const HOST_BODY = CASES.host.body;
/** The reference host app behind an adapter in tests. */
export function hostResponse(pathname) {
  if (pathname.startsWith(CASES.host.missingPrefix)) return new Response("<html>missing</html>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response(HOST_BODY, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const fill = (v) => v.replace(/\{etag:([^}]+)\}/g, (_, p) => BUNDLE.files[p].etag);

/** @param {(req: Request) => Promise<Response>} fetcher @param {{ level?: "core"|"full", base?: string }} [opts] */
export async function runConformance(fetcher, opts = {}) {
  const level = opts.level ?? "core";
  const base = (opts.base ?? "https://acme.example").replace(/\/+$/, "");
  const results = [];
  for (const c of CASES.cases) {
    if (level === "core" && c.level !== "core") continue;
    const headers = Object.fromEntries(Object.entries(c.request.headers ?? {}).map(([k, v]) => [k, fill(v)]));
    const req = new Request(base + c.request.path, { method: c.request.method ?? "GET", headers, body: c.request.body, redirect: "manual" });
    const failures = [];
    let res;
    try {
      res = await fetcher(req);
    } catch (e) {
      results.push({ id: c.id, ok: false, failures: [`threw: ${e?.message ?? e}`] });
      continue;
    }
    const body = await res.text();
    const x = c.expect;
    if (x.status !== undefined && res.status !== x.status) failures.push(`status ${res.status}, want ${x.status}`);
    for (const [k, re] of Object.entries(x.headers ?? {})) {
      const got = res.headers.get(k);
      if (got === null || !new RegExp(re, "i").test(got)) failures.push(`header ${k}: ${JSON.stringify(got)} !~ /${re}/`);
    }
    if (x.bodyEqualsFile && body !== BUNDLE.files[x.bodyEqualsFile].body) failures.push(`body differs from bundle file ${x.bodyEqualsFile}`);
    if (x.etagEqualsFile && res.headers.get("etag") !== BUNDLE.files[x.etagEqualsFile].etag) failures.push(`etag ${res.headers.get("etag")} != bundle etag`);
    if (x.tokensEqualFile && res.headers.get("x-markdown-tokens") !== String(BUNDLE.files[x.tokensEqualFile].tokens)) failures.push(`x-markdown-tokens ${res.headers.get("x-markdown-tokens")} != bundle tokens`);
    if (x.bodyEqualsHost && body !== HOST_BODY) failures.push(`body is not the host body: ${JSON.stringify(body.slice(0, 80))}`);
    if (x.bodyEmpty && body !== "") failures.push(`body not empty (${body.length} chars)`);
    for (const s of x.bodyContains ?? []) if (!body.includes(s)) failures.push(`body lacks ${s}`);
    results.push({ id: c.id, ok: failures.length === 0, failures });
  }
  return { suite: CASES.suite, level, passed: results.filter((r) => r.ok).length, total: results.length, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node runner.mjs <base-url> [--level core|full]");
    process.exit(2);
  }
  const li = process.argv.indexOf("--level");
  const report = await runConformance((req) => fetch(req), { base, level: li > 0 ? process.argv[li + 1] : "core" });
  for (const r of report.results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.ok ? "" : "  " + r.failures.join("; ")}`);
  console.log(`${report.passed}/${report.total} ${report.suite} (${report.level})`);
  process.exit(report.passed === report.total ? 0 : 1);
}
