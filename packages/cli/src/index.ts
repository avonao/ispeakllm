/**
 * `ispeakllm` command line: init | generate | lint | check | keys | sign | verify | serve.
 *
 * Everything runs locally. Nothing is uploaded; `check` only fetches the URL it is given.
 * The command logic lives in `run()` so it can be tested without a shell.
 */

import { mkdir, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  FilesAdapter,
  generate,
  toFiles,
  buildAcmShell,
  pathFromFile,
  negotiate,
  markdownHeaders,
  handleConditional,
  linkHeaderValue,
  type GeneratedOutputs,
} from "@ispeakllm/core";
import { generateKeyPair, exportKeyPair, toPublicJwk, buildJwks, signManifest, signDetached, verify, type Jwk } from "@ispeakllm/sign";
import { lintLlmsTxt, checkReadiness, type Fetcher } from "@ispeakllm/lint";
import { renderPolicySet } from "@ispeakllm/policy";
import type { McpCorpus } from "@ispeakllm/mcp";
import { makeBundle } from "@ispeakllm/serve";

export const VERSION = "0.1.0";
export const CONFIG_FILE = "ispeakllm.config.json";
export const DEFAULT_KEY_FILE = ".ispeakllm/signing-key.json";
export const DEFAULT_BUNDLE_FILE = ".ispeakllm/bundle.json";

export type Config = {
  title: string;
  summary?: string;
  details?: string;
  origin?: string;
  /** Folder with Markdown/MDX sources (default `content`). */
  content?: string;
  /** Output folder (default `public`). */
  out?: string;
  /** Path to a declaration JSON (see spec/declaration). Optional. */
  policy?: string;
  /** Issuer for the AI Conformance Manifest. */
  issuer?: { name: string; contact?: string; legal_entity?: string; jurisdiction?: string };
  /** Private signing key (JWK). Default `.ispeakllm/signing-key.json`; signing is skipped when absent. */
  key?: string;
  sections?: { id: string; title: string; priority?: number }[];
  /** Where the adapter bundle is written (default `.ispeakllm/bundle.json`). */
  bundle?: string;
};

export type Io = {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  /** Fixed clock for reproducible output (tests). */
  now?: () => Date;
};

const HELP = `ispeakllm ${VERSION}

Usage: ispeakllm <command> [options]

  init                      Create ${CONFIG_FILE} and a sample content/ folder
  generate [--config f]     Build llms.txt, llms-full.txt, page .md files, policy files and the ACM
  lint <file|url>           Check an llms.txt against the llms.txt v2 rules
  check <origin>            Readiness report for a live site (fetches only that site)
  keys [--out f]            Create an Ed25519 signing key (private file, mode 600) and print its kid
  sign <file> [--key f]     Write <file>.sig.json, a detached signature
  verify <file> [--sig f] [--jwks f | --key f]
                            Verify a signed manifest, or a file against its detached signature
  serve [--port n]          Serve the output folder with Accept: text/markdown negotiation
  help | --version
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) i++;
    else out.push(args[i]!);
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadConfig(io: Io, file = CONFIG_FILE): Promise<Config> {
  const path = resolve(io.cwd, file);
  if (!existsSync(path)) throw new UsageError(`No ${file} here. Run \`ispeakllm init\` first.`);
  const cfg = await readJson<Config>(path);
  if (!cfg.title || typeof cfg.title !== "string") throw new UsageError(`${file}: "title" is required.`);
  return cfg;
}

class UsageError extends Error {}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && e.name !== "node_modules") out.push(...(await walk(p)));
    } else if (/\.(md|mdx|markdown)$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

async function writeOut(outDir: string, sitePath: string, content: string): Promise<string> {
  const target = join(outDir, ...sitePath.split("/").filter(Boolean));
  if (!resolve(target).startsWith(resolve(outDir) + sep)) throw new Error(`refusing to write outside ${outDir}: ${sitePath}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

export type GenerateResult = { outputs: GeneratedOutputs; written: string[]; signed: boolean; corpus: McpCorpus };

/** Build every artifact from the config. Exposed for adapters and tests. */
export async function buildSite(io: Io, cfg: Config): Promise<GenerateResult> {
  const contentDir = resolve(io.cwd, cfg.content ?? "content");
  const outDir = resolve(io.cwd, cfg.out ?? "public");
  if (!existsSync(contentDir)) throw new UsageError(`Content folder not found: ${relative(io.cwd, contentDir) || "."}`);
  const files = await walk(contentDir);
  const sources = await Promise.all(
    files.map(async (f) => ({ path: pathFromFile(relative(contentDir, f)), raw: await readFile(f, "utf8") })),
  );
  const outputs = await generate(new FilesAdapter(sources), {
    title: cfg.title,
    summary: cfg.summary,
    details: cfg.details,
    origin: cfg.origin?.replace(/\/+$/, ""),
    sections: cfg.sections?.map((s, i, all) => ({ id: s.id, title: s.title, priority: s.priority ?? all.length - i })), // config order = output order
  });
  const written: string[] = [];
  const served: { path: string; content: string; contentType: string }[] = [];
  const put = async (sitePath: string, content: string, contentType: string): Promise<void> => {
    written.push(await writeOut(outDir, sitePath, content));
    served.push({ path: sitePath, content, contentType });
  };
  for (const f of toFiles(outputs)) await put(f.path, f.content, f.contentType);

  let policyHeaders: Record<string, string> | undefined;
  let declaration: unknown;
  if (cfg.policy) {
    declaration = await readJson(resolve(io.cwd, cfg.policy));
    const set = renderPolicySet(declaration, cfg.origin ? { origin: cfg.origin } : {});
    for (const a of set.artifacts) {
      // Never overwrite a robots.txt the site already has: write the block beside it to merge.
      const robotsPath = join(outDir, "robots.txt");
      if (a.path === "/robots.txt" && existsSync(robotsPath) && !(await readFile(robotsPath, "utf8")).includes("# AI usage policy for")) {
        written.push(await writeOut(outDir, "/robots.ispeakllm.txt", a.body));
        served.push({ path: "/robots.txt", content: a.body, contentType: a.contentType });
        io.out("note: public robots.txt exists; the policy block is in robots.ispeakllm.txt for you to merge.");
        continue;
      }
      await put(a.path, a.body, a.contentType);
    }
    policyHeaders = { ...set.headers } as Record<string, string>;
    for (const n of set.notes) io.out(`note: ${n}`);
  }

  const domain = cfg.origin ? new URL(cfg.origin).host : "localhost";
  const shell = buildAcmShell({
    domain,
    issuer: cfg.issuer ?? { name: cfg.title },
    issued_at: (io.now?.() ?? new Date()).toISOString(),
    ai_disclosure: { systems: [] },
    origin: cfg.origin?.replace(/\/+$/, ""),
    outputs,
  });
  const keyPath = resolve(io.cwd, cfg.key ?? DEFAULT_KEY_FILE);
  let acm: Record<string, unknown> = shell as unknown as Record<string, unknown>;
  let signed = false;
  if (existsSync(keyPath)) {
    const key = await readJson<Jwk>(keyPath);
    acm = await signManifest(acm, key, { signedAt: (io.now?.() ?? new Date()).toISOString() });
    signed = true;
    await put("/.well-known/jwks.json", JSON.stringify(await buildJwks([toPublicJwk(key)]), null, 2) + "\n", "application/jwk-set+json");
  }
  await put("/.well-known/ai-conformance.json", JSON.stringify(acm, null, 2) + "\n", "application/ai-conformance+json");

  const corpus: McpCorpus = {
    siteName: cfg.title,
    pages: outputs.pages.map((p) => ({ path: p.path, title: titleOf(p.md) ?? p.path, md: p.md })),
    policy: policyHeaders,
    manifest: acm,
  };
  const bundle = await makeBundle({
    files: served,
    corpus,
    origin: cfg.origin?.replace(/\/+$/, ""),
    declaration,
    generatedAt: (io.now?.() ?? new Date()).toISOString(),
  });
  const bundlePath = resolve(io.cwd, cfg.bundle ?? DEFAULT_BUNDLE_FILE);
  await mkdir(dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, JSON.stringify(bundle) + "\n");
  written.push(bundlePath);
  return { outputs, written, signed, corpus };
}

const titleOf = (md: string): string | undefined => /^#\s+(.+)$/m.exec(md)?.[1]?.trim();

async function cmdInit(io: Io): Promise<number> {
  const cfgPath = join(io.cwd, CONFIG_FILE);
  if (existsSync(cfgPath)) {
    io.out(`${CONFIG_FILE} already exists; nothing changed.`);
    return 0;
  }
  const cfg: Config = { title: "My site", summary: "One line about what this site offers.", origin: "https://example.com", content: "content", out: "public" };
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const contentDir = join(io.cwd, "content");
  if (!existsSync(contentDir)) {
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "index.md"), "---\ntitle: Home\nsummary: What this site is about.\n---\n\n# Home\n\nWrite your page here.\n");
  }
  io.out(`Created ${CONFIG_FILE}. Edit it, then run \`ispeakllm generate\`.`);
  io.out(`Optional: \`ispeakllm keys\` to sign the AI Conformance Manifest. Keep ${DEFAULT_KEY_FILE} out of git.`);
  return 0;
}

async function cmdGenerate(io: Io, args: string[]): Promise<number> {
  const cfg = await loadConfig(io, flag(args, "--config"));
  const r = await buildSite(io, cfg);
  io.out(`Wrote ${r.written.length} files (${r.outputs.pages.length} pages) to ${cfg.out ?? "public"}/.`);
  io.out(r.signed ? "AI Conformance Manifest signed." : "AI Conformance Manifest written unsigned (no key; run `ispeakllm keys`).");
  const lint = lintLlmsTxt(r.outputs.llmsTxt);
  for (const i of lint.issues) io.out(`llms.txt:${i.line} ${i.severity} ${i.code}: ${i.message}`);
  return lint.ok ? 0 : 1;
}

async function cmdLint(io: Io, args: string[]): Promise<number> {
  const target = positional(args)[0];
  if (!target) throw new UsageError("lint needs a file or URL.");
  let text: string;
  if (/^https?:\/\//.test(target)) {
    const f = io.fetch ?? fetch;
    const res = await f(target);
    if (!res.ok) {
      io.err(`${target}: HTTP ${res.status}`);
      return 1;
    }
    text = await res.text();
  } else text = await readFile(resolve(io.cwd, target), "utf8");
  const r = lintLlmsTxt(text);
  for (const i of r.issues) io.out(`${target}:${i.line} ${i.severity} ${i.code}: ${i.message}`);
  io.out(r.ok ? `${target}: ok (${r.issues.length} warnings)` : `${target}: ${r.issues.filter((i) => i.severity === "error").length} errors`);
  return r.ok ? 0 : 1;
}

async function cmdCheck(io: Io, args: string[]): Promise<number> {
  const origin = positional(args)[0];
  if (!origin || !/^https?:\/\//.test(origin)) throw new UsageError("check needs an origin such as https://example.com");
  const f = io.fetch ?? fetch;
  const fetcher: Fetcher = async (url, init) => {
    const res = await f(url, { headers: init?.headers, redirect: "follow" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.text() };
  };
  const rep = await checkReadiness(origin, fetcher);
  const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", na: " n/a" } as const;
  for (const i of rep.items) io.out(`${mark[i.status]}  ${i.title}: ${i.detail}`);
  io.out(`${rep.passed}/${rep.total} checks pass.`);
  if (args.includes("--json")) io.out(JSON.stringify(rep));
  return rep.items.some((i) => i.status === "fail") ? 1 : 0;
}

async function cmdKeys(io: Io, args: string[]): Promise<number> {
  const target = resolve(io.cwd, flag(args, "--out") ?? DEFAULT_KEY_FILE);
  if (existsSync(target) && !args.includes("--force")) {
    io.err(`${relative(io.cwd, target)} exists. Pass --force to replace it (the old key stops verifying new files).`);
    return 1;
  }
  const pair = await generateKeyPair();
  const { privateKey, publicKey } = exportKeyPair(pair);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ ...privateKey, kid: pair.kid }, null, 2) + "\n", { mode: 0o600 });
  await chmod(target, 0o600);
  const pub = target.replace(/\.json$/, "") + ".public.json";
  await writeFile(pub, JSON.stringify({ ...publicKey, kid: pair.kid }, null, 2) + "\n");
  io.out(`kid ${pair.kid}`);
  io.out(`Private key: ${relative(io.cwd, target)} (mode 600, never commit it). Public key: ${relative(io.cwd, pub)}`);
  return 0;
}

async function cmdSign(io: Io, args: string[]): Promise<number> {
  const file = positional(args)[0];
  if (!file) throw new UsageError("sign needs a file.");
  const keyPath = resolve(io.cwd, flag(args, "--key") ?? DEFAULT_KEY_FILE);
  if (!existsSync(keyPath)) throw new UsageError(`No key at ${relative(io.cwd, keyPath)}. Run \`ispeakllm keys\`.`);
  const key = await readJson<Jwk>(keyPath);
  const bytes = new Uint8Array(await readFile(resolve(io.cwd, file)));
  const sig = await signDetached(bytes, key, io.now ? { signedAt: io.now().toISOString() } : {});
  const out = resolve(io.cwd, flag(args, "--out") ?? `${file}.sig.json`);
  await writeFile(out, JSON.stringify(sig, null, 2) + "\n");
  io.out(`Wrote ${relative(io.cwd, out)}`);
  return 0;
}

async function cmdVerify(io: Io, args: string[]): Promise<number> {
  const file = positional(args)[0];
  if (!file) throw new UsageError("verify needs a file.");
  const opts: { jwks?: unknown; publicKey?: string } = {};
  const jwks = flag(args, "--jwks");
  const key = flag(args, "--key");
  if (jwks) opts.jwks = await readFile(resolve(io.cwd, jwks), "utf8");
  if (key) opts.publicKey = await readFile(resolve(io.cwd, key), "utf8");
  const sigFlag = flag(args, "--sig");
  const sigPath = resolve(io.cwd, sigFlag ?? `${file}.sig.json`);
  const bytes = new Uint8Array(await readFile(resolve(io.cwd, file)));
  const verdict =
    sigFlag || existsSync(sigPath)
      ? await verify({ kind: "detached", bytes, signature: await readJson(sigPath) }, opts)
      : await verify({ kind: "manifest", manifest: new TextDecoder().decode(bytes) }, opts);
  io.out(verdict.ok ? `${file}: valid (${verdict.kind})` : `${file}: INVALID (${verdict.code}) ${verdict.reason ?? ""}`.trim());
  return verdict.ok ? 0 : 1;
}

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Fetch-style handler over a generated output folder. `/llms.txt`, `/llms-full.txt` and
 * page `.md` files are served as Markdown; an HTML request with `Accept: text/markdown`
 * gets the page's Markdown. Used by `ispeakllm serve`; adapters ship their own.
 */
export function createStaticHandler(outDir: string, opts: { origin?: string } = {}): (req: Request) => Promise<Response> {
  const root = resolve(outDir);
  const read = async (sitePath: string): Promise<{ bytes: Uint8Array; path: string } | null> => {
    const p = resolve(root, "." + sitePath);
    if (p !== root && !p.startsWith(root + sep)) return null;
    try {
      const s = await stat(p);
      if (s.isDirectory()) return read(sitePath.replace(/\/?$/, "/index.html"));
      return { bytes: new Uint8Array(await readFile(p)), path: sitePath };
    } catch {
      return null;
    }
  };
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const v = negotiate({ pathname: decodeURIComponent(url.pathname), accept: req.headers.get("accept") });
    let path = url.pathname;
    if (v.variant === "llmstxt") path = "/llms.txt";
    else if (v.variant === "llmsfull") path = "/llms-full.txt";
    else if (v.variant === "acm") path = "/.well-known/ai-conformance.json";
    else if (v.variant === "md") path = v.pagePath === "/" || !v.pagePath ? "/index.md" : `${v.pagePath}.md`;
    const found = await read(path);
    if (!found) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", Vary: "Accept" } });
    const body = found.bytes;
    const ext = /\.[a-z0-9]+$/i.exec(found.path)?.[0]?.toLowerCase() ?? "";
    const text = new TextDecoder().decode(body);
    if (v.variant === "md" || v.variant === "llmstxt" || v.variant === "llmsfull") {
      const headers = await markdownHeaders(text);
      const cond = handleConditional(req.headers, headers.ETag!);
      if (cond) return new Response(null, { status: 304, headers: cond.headers });
      return new Response(req.method === "HEAD" ? null : (body as BodyInit), { headers });
    }
    const headers: Record<string, string> = { "Content-Type": TYPES[ext] ?? "application/octet-stream", Vary: "Accept" };
    if (v.variant === "acm") headers["Content-Type"] = "application/ai-conformance+json";
    if (ext === ".html" || ext === "") headers.Link = linkHeaderValue({ pathname: url.pathname, origin: opts.origin });
    return new Response(req.method === "HEAD" ? null : (body as BodyInit), { headers });
  };
}

async function cmdServe(io: Io, args: string[]): Promise<number> {
  const cfg = existsSync(join(io.cwd, CONFIG_FILE)) ? await loadConfig(io) : ({ title: "", out: "public" } as Config);
  const outDir = resolve(io.cwd, flag(args, "--dir") ?? cfg.out ?? "public");
  const port = Number(flag(args, "--port") ?? 4321);
  const handler = createStaticHandler(outDir);
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handler(new Request(`http://localhost:${port}${req.url ?? "/"}`, { method: req.method, headers }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
    io.out(`${req.method} ${req.url} ${r.status}`);
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  io.out(`Serving ${relative(io.cwd, outDir) || "."} on http://127.0.0.1:${port} (Ctrl+C to stop)`);
  await new Promise(() => {});
  return 0;
}

/** Run one CLI invocation. Returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "init":
        return await cmdInit(io);
      case "generate":
        return await cmdGenerate(io, args);
      case "lint":
        return await cmdLint(io, args);
      case "check":
        return await cmdCheck(io, args);
      case "keys":
        return await cmdKeys(io, args);
      case "sign":
        return await cmdSign(io, args);
      case "verify":
        return await cmdVerify(io, args);
      case "serve":
        return await cmdServe(io, args);
      case "--version":
      case "-v":
        io.out(VERSION);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      default:
        io.err(`Unknown command: ${cmd}\n`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    io.err(e instanceof UsageError ? e.message : `error: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}
