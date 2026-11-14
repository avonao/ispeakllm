/**
 * One fetch-style request handler shared by every IspeakLLM adapter
 * (Cloudflare Worker, Next.js middleware, Express, Hono).
 *
 * It serves a generated bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`):
 * llms.txt, llms-full.txt, page `.md`, `Accept: text/markdown` negotiation, the AI Conformance
 * Manifest, policy files and headers, a read-only MCP endpoint, and an optional graded fetch log.
 *
 * When a page has no source Markdown and an upstream is configured, the HTML is fetched
 * and converted with @ispeakllm/html-md, and the response says so (`x-ispeakllm-source: html-fallback`).
 * Human HTML is never changed beyond adding `Link`, `Vary` and policy headers.
 */

import { negotiate, markdownHeaders, handleConditional, linkHeaderValue, sha256Hex, estimateTokens } from "@ispeakllm/core";
import { renderPolicySet, type PolicySet } from "@ispeakllm/policy";
import { createMcpHandler, serverCard, type McpCorpus } from "@ispeakllm/mcp";
import { convertHtml } from "@ispeakllm/html-md";
import { buildFetchRecord, gradeRequest, messageFromRequest, matchAgentByUserAgent, type FetchLogRecord, type GradeDeps } from "@ispeakllm/agents";

export const BUNDLE_VERSION = 1 as const;

export type BundleFile = { type: string; body: string };
export type Bundle = {
  version: typeof BUNDLE_VERSION;
  generatedAt: string;
  origin?: string;
  /** Site path -> file. Includes /llms.txt, /llms-full.txt, page .md, policy files, /.well-known/*. */
  files: Record<string, BundleFile>;
  /** Corpus for the MCP tools. */
  corpus: McpCorpus;
  /** The policy declaration, so per-path headers follow the same longest-prefix rule. */
  declaration?: unknown;
};

export type FetchEvent = {
  request: Request;
  path: string;
  variant: "md" | "llmstxt" | "llmsfull" | "acm" | "policy" | "mcp" | "html";
  status: number;
  source: "bundle" | "html-fallback" | "upstream" | "none";
  contentSha256: string | null;
  /** Present when `fetchLog` is configured and the request came from an AI agent (claimed or verified). */
  record?: FetchLogRecord;
};

export type ServeOptions = {
  bundle: Bundle | (() => Promise<Bundle> | Bundle);
  /**
   * Upstream for human HTML and for the html-md fallback. A function receives the request
   * (e.g. Next's `NextResponse.next()` is not a fetch, so adapters pass their own).
   */
  upstream?: string | ((req: Request) => Promise<Response>);
  /** Path of the MCP endpoint (default `/mcp`; `false` disables it). */
  mcpPath?: string | false;
  /** Convert upstream HTML when a page has no source Markdown (default true when an upstream is set). */
  htmlFallback?: boolean;
  /** Grade agent fetches and build `ispeakllm.fetch/1` records. Needs a salt (16+ chars) for IP hashing. */
  fetchLog?: { ipSalt: string; deps?: GradeDeps; ipOf?: (req: Request) => string | null };
  /** Called for every request this handler answers, after the response is built. */
  onFetch?: (e: FetchEvent) => void | Promise<void>;
  /** Cache-Control for Markdown variants (default `public, max-age=300`). */
  cacheControl?: string;
  now?: () => Date;
};

const POLICY_PATHS = new Set(["/robots.txt", "/ai.txt", "/license.xml", "/.well-known/tdmrep.json", "/.well-known/jwks.json"]);
const MCP_CARD = "/.well-known/mcp.json";

export type AgentHandler = {
  /** Answer the request, or return null to let the host continue (Next/Express/Hono `next()`). */
  handle(req: Request): Promise<Response | null>;
  /** Like `handle`, but falls back to the upstream or a 404. For a stand-alone Worker. */
  fetch(req: Request): Promise<Response>;
};

export function createAgentHandler(opts: ServeOptions): AgentHandler {
  let policyCache: { decl: unknown; set: PolicySet } | null = null;
  const loadBundle = async (): Promise<Bundle> => (typeof opts.bundle === "function" ? await opts.bundle() : opts.bundle);
  const policyFor = (b: Bundle): PolicySet | null => {
    if (!b.declaration) return null;
    if (policyCache?.decl !== b.declaration) policyCache = { decl: b.declaration, set: renderPolicySet(b.declaration, b.origin ? { origin: b.origin } : {}) };
    return policyCache.set;
  };
  const mcpPath = opts.mcpPath === undefined ? "/mcp" : opts.mcpPath;
  const mcp = createMcpHandler(async () => (await loadBundle()).corpus);
  const upstreamFetch = (req: Request): Promise<Response> | null => {
    if (!opts.upstream) return null;
    if (typeof opts.upstream === "function") return opts.upstream(req);
    const u = new URL(req.url);
    const target = new URL(u.pathname + u.search, opts.upstream);
    return fetch(new Request(target, req));
  };

  const emit = async (req: Request, e: Omit<FetchEvent, "request" | "record">, body: string | null): Promise<void> => {
    if (!opts.onFetch && !opts.fetchLog) return;
    let record: FetchLogRecord | undefined;
    if (opts.fetchLog && e.contentSha256 && (req.headers.has("signature-agent") || req.headers.has("signature") || matchAgentByUserAgent(req.headers.get("user-agent")))) {
      const ip = opts.fetchLog.ipOf?.(req) ?? req.headers.get("cf-connecting-ip");
      const now = opts.now?.() ?? new Date();
      const identity = await gradeRequest({ message: messageFromRequest(req), ip, now }, opts.fetchLog.deps ?? {});
      record = await buildFetchRecord({
        fetchId: crypto.randomUUID(),
        url: req.url,
        contentSha256: e.contentSha256,
        fetchedAtIso: now.toISOString(),
        status: e.status,
        identity,
        userAgent: req.headers.get("user-agent"),
        ip,
        ipSalt: opts.fetchLog.ipSalt,
      });
    }
    await opts.onFetch?.({ ...e, request: req, ...(record ? { record } : {}) });
  };

  const withPolicy = (h: Headers, set: PolicySet | null, path: string): void => {
    if (!set) return;
    for (const [k, v] of Object.entries(set.headersFor(path))) if (v) h.set(k, v);
  };

  const markdownResponse = async (req: Request, body: string, set: PolicySet | null, path: string, extra: Record<string, string> = {}): Promise<Response> => {
    const base = await markdownHeaders(body, { cacheControl: opts.cacheControl ?? "public, max-age=300" });
    const h = new Headers({ ...base, ...extra });
    withPolicy(h, set, path);
    const cond = handleConditional(req.headers, base.ETag!);
    if (cond) return new Response(null, { status: 304, headers: new Headers({ ...cond.headers, ...Object.fromEntries(h) }) });
    return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: h });
  };

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const b = await loadBundle();
    const set = policyFor(b);

    if (mcpPath && path === mcpPath) {
      const res = await mcp(req);
      await emit(req, { path, variant: "mcp", status: res.status, source: "bundle", contentSha256: null }, null);
      return res;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    if (mcpPath && path === MCP_CARD) {
      const card = JSON.stringify(serverCard(b.corpus, new URL(mcpPath, url).toString()));
      return new Response(card, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
    }

    if (POLICY_PATHS.has(path) && b.files[path]) {
      const f = b.files[path]!;
      const res = new Response(req.method === "HEAD" ? null : f.body, { headers: { "content-type": f.type, "cache-control": "public, max-age=300" } });
      await emit(req, { path, variant: "policy", status: 200, source: "bundle", contentSha256: await sha256Hex(f.body) }, f.body);
      return res;
    }

    const v = negotiate({ pathname: path, accept: req.headers.get("accept") });
    if (v.variant === "acm") {
      const f = b.files["/.well-known/ai-conformance.json"];
      if (!f) return null;
      const h = new Headers({ "content-type": "application/ai-conformance+json", "cache-control": "public, max-age=300", vary: "Accept" });
      await emit(req, { path, variant: "acm", status: 200, source: "bundle", contentSha256: await sha256Hex(f.body) }, f.body);
      return new Response(req.method === "HEAD" ? null : f.body, { headers: h });
    }
    if (v.variant === "llmstxt" || v.variant === "llmsfull") {
      const f = b.files[v.variant === "llmstxt" ? "/llms.txt" : "/llms-full.txt"];
      if (!f) return null;
      const res = await markdownResponse(req, f.body, set, "/");
      await emit(req, { path, variant: v.variant, status: res.status, source: "bundle", contentSha256: await sha256Hex(f.body) }, f.body);
      return res;
    }
    if (v.variant === "md") {
      const pagePath = v.pagePath && v.pagePath !== "/" ? v.pagePath : "/";
      const mdPath = pagePath === "/" ? "/index.md" : `${pagePath}.md`;
      const f = b.files[mdPath];
      if (f) {
        const res = await markdownResponse(req, f.body, set, pagePath);
        await emit(req, { path, variant: "md", status: res.status, source: "bundle", contentSha256: await sha256Hex(f.body) }, f.body);
        return res;
      }
      if (opts.upstream && opts.htmlFallback !== false) {
        const upUrl = new URL(pagePath, url);
        const up = await upstreamFetch(new Request(upUrl, { headers: { accept: "text/html" } }));
        if (up && up.ok && (up.headers.get("content-type") ?? "").includes("text/html")) {
          const converted = convertHtml(await up.text(), { baseUrl: upUrl.toString(), frontmatter: true });
          const res = await markdownResponse(req, converted.markdown, set, pagePath, { "x-ispeakllm-source": "html-fallback" });
          await emit(req, { path, variant: "md", status: res.status, source: "html-fallback", contentSha256: await sha256Hex(converted.markdown) }, converted.markdown);
          return res;
        }
      }
      if (path.endsWith(".md")) {
        await emit(req, { path, variant: "md", status: 404, source: "none", contentSha256: null }, null);
        return new Response("No Markdown is published for this page.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } });
      }
      return null; // Accept: text/markdown on a page we don't know: let the host answer with HTML.
    }
    return null;
  }

  const decorate = async (req: Request, res: Response): Promise<Response> =>
    decorateHtml(await loadBundle(), req, res, { linkAlways: !!opts.upstream && opts.htmlFallback !== false, policy: policyFor(await loadBundle()) });

  return {
    handle,
    async fetch(req) {
      const r = await handle(req);
      if (r) return r;
      const up = upstreamFetch(req);
      if (up) {
        const res = await decorate(req, await up);
        await emit(req, { path: new URL(req.url).pathname, variant: "html", status: res.status, source: "upstream", contentSha256: null }, null);
        return res;
      }
      return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } });
    },
  };
}

/** Headers to add to a human HTML page: `Link` to its Markdown (when published), `Vary: Accept`, policy headers. */
export function discoveryHeaders(bundle: Bundle, pathname: string, opts: { linkAlways?: boolean; policy?: PolicySet | null } = {}): Record<string, string> {
  const h: Record<string, string> = { vary: "Accept" };
  const hasMd = !!bundle.files[pathname === "/" ? "/index.md" : `${pathname.replace(/\/$/, "")}.md`];
  if (hasMd || opts.linkAlways) h.link = linkHeaderValue({ pathname, origin: bundle.origin });
  const set = opts.policy !== undefined ? opts.policy : bundle.declaration ? renderPolicySet(bundle.declaration, bundle.origin ? { origin: bundle.origin } : {}) : null;
  if (set) for (const [k, v] of Object.entries(set.headersFor(pathname))) if (v) h[k.toLowerCase()] = v;
  return h;
}

/** Decorate an HTML response from the host app with discovery headers. The body is untouched. */
export async function decorateHtml(bundle: Bundle, req: Request, res: Response, opts: { linkAlways?: boolean; policy?: PolicySet | null } = {}): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(discoveryHeaders(bundle, new URL(req.url).pathname, opts))) {
    if (k === "vary") {
      const cur = h.get("vary");
      if (!cur || !/\baccept\b/i.test(cur)) h.set("vary", cur ? `${cur}, Accept` : "Accept");
    } else if (k === "link") h.append("link", v);
    else h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Build a bundle from already-generated files (the CLI uses this). */
export function makeBundle(input: { files: { path: string; content: string; contentType: string }[]; corpus: McpCorpus; origin?: string; declaration?: unknown; generatedAt: string }): Bundle {
  const files: Record<string, BundleFile> = {};
  for (const f of input.files) files[f.path] = { type: f.contentType, body: f.content };
  return { version: BUNDLE_VERSION, generatedAt: input.generatedAt, origin: input.origin, files, corpus: input.corpus, ...(input.declaration ? { declaration: input.declaration } : {}) };
}

export { estimateTokens };
