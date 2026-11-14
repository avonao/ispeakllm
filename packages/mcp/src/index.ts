/**
 * @ispeakllm/mcp — read-only per-site MCP server (JSON-RPC 2.0 over HTTP POST, MCP "streamable HTTP" single-response mode).
 * Tools: search, get_page, get_policy, get_manifest. Answers only from the supplied corpus; never invents content.
 * Zero dependencies; runs in Workers and Node.
 */

export interface McpPage { path: string; title: string; summary?: string; md: string; }
export interface McpCorpus {
  siteName: string;
  pages: McpPage[];
  /** Policy artifacts by name, e.g. { "robots.txt": "...", "content-signal": "ai-train=no" }. */
  policy?: Record<string, string>;
  /** Signed manifest JSON (as served at /.well-known/ai-conformance.json). */
  manifest?: unknown;
}

export const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  { name: "search", description: "Search the site's published pages. Returns matching page paths, titles and snippets.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "get_page", description: "Return the Markdown of one published page by path.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "get_policy", description: "Return the site's AI-use policy artifacts (robots.txt block, Content-Signal, RSL, AIPREF…).", inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "get_manifest", description: "Return the signed AI Conformance Manifest, if published.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];

const tokenize = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];

export function searchPages(corpus: McpCorpus, query: string, limit = 5): { path: string; title: string; score: number; snippet: string }[] {
  const q = tokenize(query);
  if (!q.length) return [];
  const res: { path: string; title: string; score: number; snippet: string }[] = [];
  for (const p of corpus.pages) {
    const tTok = tokenize(p.title), bTok = tokenize(p.md);
    let score = 0;
    for (const w of q) { score += 3 * tTok.filter((x) => x === w).length; score += bTok.filter((x) => x === w).length; }
    if (!score) continue;
    const low = p.md.toLowerCase(); const idx = low.indexOf(q[0]);
    const start = Math.max(0, idx < 0 ? 0 : idx - 60);
    res.push({ path: p.path, title: p.title, score, snippet: p.md.slice(start, start + 200).replace(/\s+/g, " ").trim() });
  }
  return res.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(Math.max(limit, 1), 20));
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: any, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export function handleRpc(corpus: McpCorpus, msg: Rpc): unknown | null {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(msg?.id, -32600, "Invalid Request");
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize": return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: `${corpus.siteName} (IspeakLLM)`, version: "0.1.0" }, instructions: "Read-only access to this site's published content. Answers come only from published pages." });
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name; const a = params?.arguments ?? {};
      if (name === "search") {
        if (typeof a.query !== "string" || !a.query.trim()) return ok(id, text("`query` is required.", true));
        const r = searchPages(corpus, a.query, typeof a.limit === "number" ? a.limit : 5);
        return ok(id, text(r.length ? JSON.stringify(r, null, 2) : "No published page matches this query."));
      }
      if (name === "get_page") {
        const want = typeof a.path === "string" ? a.path.replace(/\.md$/, "").replace(/\/+$/, "") || "/" : "";
        const p = corpus.pages.find((x) => (x.path.replace(/\/+$/, "") || "/") === want);
        return ok(id, p ? text(p.md) : text(`Not found: ${a.path ?? ""}. Only published pages are available.`, true));
      }
      if (name === "get_policy") {
        const pol = corpus.policy ?? {};
        if (typeof a.name === "string") return ok(id, a.name in pol ? text(pol[a.name]) : text(`No policy artifact "${a.name}". Available: ${Object.keys(pol).join(", ") || "none"}.`, true));
        return ok(id, text(Object.keys(pol).length ? JSON.stringify(pol, null, 2) : "No policy published."));
      }
      if (name === "get_manifest") return ok(id, corpus.manifest ? text(JSON.stringify(corpus.manifest, null, 2)) : text("No manifest published.", true));
      return err(id, -32602, `Unknown tool: ${name}`);
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

/** Fetch-API handler: POST JSON-RPC (single or batch). GET returns 405 (no server-initiated stream). */
export function createMcpHandler(corpus: McpCorpus | (() => Promise<McpCorpus> | McpCorpus)) {
  return async (req: Request): Promise<Response> => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    let body: any;
    try { body = await req.json(); } catch { return json(err(null, -32700, "Parse error"), 400); }
    const c = typeof corpus === "function" ? await corpus() : corpus;
    if (Array.isArray(body)) { const out = body.map((m) => handleRpc(c, m)).filter((x) => x !== null); return out.length ? json(out) : new Response(null, { status: 202 }); }
    const r = handleRpc(c, body);
    return r === null ? new Response(null, { status: 202 }) : json(r);
  };
}

/** /.well-known/mcp/server-card.json content. */
export function serverCard(corpus: McpCorpus, endpoint: string) {
  return { name: `${corpus.siteName} (IspeakLLM)`, version: "0.1.0", protocolVersion: PROTOCOL_VERSION, transport: { type: "streamable-http", url: endpoint }, tools: TOOLS.map((t) => ({ name: t.name, description: t.description })), readOnly: true };
}
