/**
 * @ispeakllm/html-md — HTML → Markdown FALLBACK converter.
 *
 * Source-first Markdown (from a ContentSource) is always preferred; this converter
 * exists for pages that only exist as rendered HTML. Output is always labelled
 * `fallback` by the caller via `convertHtml().fallback === true`.
 *
 * Zero dependencies: a small tolerant tokenizer, runs identically in Workers, Node and browsers.
 */

export interface ConvertOptions {
  /** Absolute page URL, used to resolve relative links and images. */
  baseUrl?: string;
  /** Keep JSON-LD blocks as one fenced `json` block at the end (default true). */
  keepJsonLd?: boolean;
  /** Prepend YAML frontmatter with title/description/image (default true). */
  frontmatter?: boolean;
}

export interface ConvertResult {
  markdown: string;
  title?: string;
  description?: string;
  /** Always true: this output was converted from rendered HTML, not authored. */
  fallback: true;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "canvas", "form", "button", "select", "textarea", "head", "nav", "footer", "aside", "dialog"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "ul", "ol", "li", "table", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "figure", "figcaption", "dl", "dt", "dd", "details", "summary"]);

interface El { tag: string; attrs: Record<string, string>; children: Node[]; }
type Node = El | string;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", rarr: "→", larr: "←", laquo: "«", raquo: "»" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function parse(html: string): { root: El; jsonLd: string[]; meta: Record<string, string>; title?: string } {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const jsonLd: string[] = [];
  const meta: Record<string, string> = {};
  let title: string | undefined;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/gi;
  let m: RegExpExecArray | null;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(html))) {
    const whole = m[0];
    if (m[3] !== undefined) { top().children.push(whole); continue; }
    if (!m[1]) continue; // comment / doctype
    const tag = m[1].toLowerCase();
    const closing = whole[1] === "/";
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[2]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    if (tag === "script" || tag === "style" || tag === "title") {
      const endRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(re.lastIndex);
      const e = endRe.exec(rest);
      const body = e ? rest.slice(0, e.index) : rest;
      re.lastIndex += e ? e.index + e[0].length : rest.length;
      if (tag === "script" && /ld\+json/i.test(attrs.type ?? "")) jsonLd.push(body.trim());
      if (tag === "title" && title === undefined) title = decode(body).trim();
      continue;
    }
    if (tag === "meta") {
      const k = (attrs.name ?? attrs.property ?? "").toLowerCase();
      if (k && attrs.content !== undefined) meta[k] = attrs.content;
    }
    const el: El = { tag, attrs, children: [] };
    // implicit closes
    if (tag === "li") { for (let i = stack.length - 1; i > 0 && stack[i].tag !== "ul" && stack[i].tag !== "ol"; i--) if (stack[i].tag === "li") { stack.length = i; break; } }
    if (tag === "p") { if (top().tag === "p") stack.pop(); }
    top().children.push(el);
    if (!VOID.has(tag) && !whole.endsWith("/>")) stack.push(el);
  }
  return { root, jsonLd, meta, title };
}

function text(n: Node): string {
  if (typeof n === "string") return decode(n);
  return n.children.map(text).join("");
}

/** Score a node as "main content" candidate. */
function findMain(root: El): El {
  let found: El | undefined;
  const walk = (n: El) => {
    if (found) return;
    if (n.tag === "main" || n.attrs.role === "main" || n.tag === "article") { found = n; return; }
    for (const c of n.children) if (typeof c !== "string") walk(c);
  };
  walk(root);
  if (found) return found;
  // fallback: body
  const body = (function find(n: El): El | undefined {
    if (n.tag === "body") return n;
    for (const c of n.children) if (typeof c !== "string") { const r = find(c); if (r) return r; }
  })(root);
  return body ?? root;
}

const NOISE = /(^|[\s_-])(nav|navbar|menu|footer|sidebar|cookie|consent|banner|breadcrumb|share|social|newsletter|modal|popup|advert|ads?)([\s_-]|$)/i;

function resolve(url: string, base?: string): string {
  if (!base) return url;
  try { return new URL(url, base).toString(); } catch { return url; }
}

function inline(nodes: Node[], o: ConvertOptions): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += decode(n).replace(/\s+/g, " "); continue; }
    if (DROP.has(n.tag) || n.attrs.hidden !== undefined || n.attrs["aria-hidden"] === "true") continue;
    const inner = () => inline(n.children, o);
    switch (n.tag) {
      case "strong": case "b": { const t = inner().trim(); out += t ? `**${t}**` : ""; break; }
      case "em": case "i": { const t = inner().trim(); out += t ? `*${t}*` : ""; break; }
      case "code": { const t = text(n); out += t ? "`" + t.replace(/`/g, "'") + "`" : ""; break; }
      case "br": out += "  \n"; break;
      case "a": {
        const href = n.attrs.href;
        const t = inner().trim();
        if (!t) break;
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) out += t;
        else out += `[${t}](${resolve(href, o.baseUrl)})`;
        break;
      }
      case "img": {
        const alt = (n.attrs.alt ?? "").trim();
        const src = n.attrs.src;
        if (src && alt) out += `![${alt}](${resolve(src, o.baseUrl)})`;
        break;
      }
      default: out += inner();
    }
  }
  return out;
}

function block(n: El, o: ConvertOptions, ctx: { list?: { ordered: boolean; i: number; depth: number } } = {}): string {
  if (DROP.has(n.tag) || n.attrs.hidden !== undefined || n.attrs["aria-hidden"] === "true") return "";
  if (NOISE.test(`${n.attrs.class ?? ""} ${n.attrs.id ?? ""}`) && n.tag !== "body" && n.tag !== "html") return "";
  const kids = () => n.children.map((c) => (typeof c === "string" ? "" : block(c, o))).join("");
  const mixed = (): string => {
    // children can be inline text and blocks mixed
    let buf = "";
    let res = "";
    const flush = () => { const t = buf.replace(/[ \t]+/g, " ").trim(); if (t) res += t + "\n\n"; buf = ""; };
    for (const c of n.children) {
      if (typeof c !== "string" && (BLOCK.has(c.tag))) { flush(); res += block(c, o); }
      else buf += inline([c], o);
    }
    flush();
    return res;
  };
  switch (n.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = inline(n.children, o).trim();
      return t ? `${"#".repeat(Number(n.tag[1]))} ${t}\n\n` : "";
    }
    case "p": { const t = inline(n.children, o).trim(); return t ? t + "\n\n" : ""; }
    case "pre": { const t = text(n).replace(/\n+$/, ""); const lang = /language-([\w-]+)/.exec(JSON.stringify(n.children[0] && typeof n.children[0] !== "string" ? n.children[0].attrs : {}))?.[1] ?? ""; return t ? "```" + lang + "\n" + t + "\n```\n\n" : ""; }
    case "blockquote": { const t = mixed().trim(); return t ? t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n" : ""; }
    case "hr": return "---\n\n";
    case "ul": case "ol": {
      const ordered = n.tag === "ol";
      const depth = (ctx.list?.depth ?? -1) + 1;
      let i = 0; let s = "";
      for (const c of n.children) {
        if (typeof c === "string" || c.tag !== "li") continue;
        i++;
        const marker = ordered ? `${i}.` : "-";
        const inlineParts: Node[] = []; let nested = "";
        for (const k of c.children) {
          if (typeof k !== "string" && (k.tag === "ul" || k.tag === "ol")) nested += block(k, o, { list: { ordered, i, depth } });
          else inlineParts.push(k);
        }
        const line = inline(inlineParts, o).trim();
        if (line || nested) s += `${"  ".repeat(depth)}${marker} ${line}\n` + nested.replace(/\n\n$/, "\n");
      }
      return depth === 0 ? s + "\n" : s;
    }
    case "table": {
      const rows: string[][] = [];
      const collect = (e: El) => { for (const c of e.children) { if (typeof c === "string") continue; if (c.tag === "tr") rows.push(c.children.filter((x): x is El => typeof x !== "string" && (x.tag === "td" || x.tag === "th")).map((x) => inline(x.children, o).replace(/\|/g, "\\|").replace(/\n/g, " ").trim())); else if (["thead", "tbody", "tfoot"].includes(c.tag)) collect(c); } };
      collect(n);
      const w = Math.max(0, ...rows.map((r) => r.length));
      if (!w || !rows.length) return "";
      const pad = (r: string[]) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
      return [pad(rows[0]), `| ${Array(w).fill("---").join(" | ")} |`, ...rows.slice(1).map(pad)].join("\n") + "\n\n";
    }
    case "figure": case "figcaption": case "div": case "section": case "article": case "main": case "header": case "details": case "summary": case "li": case "dl": case "dt": case "dd":
      return mixed();
    case "body": case "html": case "#root": case "span": case "a": return n.children.some((c) => typeof c !== "string" && BLOCK.has(c.tag)) ? mixed() : (() => { const t = inline(n.children, o).trim(); return t ? t + "\n\n" : ""; })();
    default: return kids() || (() => { const t = inline(n.children, o).trim(); return t ? t + "\n\n" : ""; })();
  }
}

function yamlStr(s: string): string { return JSON.stringify(s.replace(/\s+/g, " ").trim()); }

/** Convert rendered HTML into Markdown. Always `fallback: true`. */
export function convertHtml(html: string, options: ConvertOptions = {}): ConvertResult {
  const o = { keepJsonLd: true, frontmatter: true, ...options };
  const { root, jsonLd, meta, title } = parse(html);
  const main = findMain(root);
  let body = block(main, o).replace(/\n{3,}/g, "\n\n").trim();
  const description = meta.description ?? meta["og:description"];
  const image = meta["og:image"];
  const pageTitle = (meta["og:title"] ?? title)?.trim();
  if (o.keepJsonLd && jsonLd.length) {
    const valid = jsonLd.filter((j) => { try { JSON.parse(j); return true; } catch { return false; } });
    if (valid.length) body += "\n\n```json\n" + valid.map((j) => JSON.stringify(JSON.parse(j))).join("\n") + "\n```";
  }
  let md = body;
  if (o.frontmatter && (pageTitle || description || image)) {
    const fm = ["---"];
    if (pageTitle) fm.push(`title: ${yamlStr(pageTitle)}`);
    if (description) fm.push(`description: ${yamlStr(description)}`);
    if (image) fm.push(`image: ${yamlStr(resolve(image, o.baseUrl))}`);
    fm.push("source: html-fallback", "---", "");
    md = fm.join("\n") + "\n" + body;
  }
  return { markdown: md.trimEnd() + "\n", title: pageTitle, description, fallback: true };
}
