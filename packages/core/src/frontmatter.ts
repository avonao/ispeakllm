// Ported from llms-txt/src/mdx-adapter.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * YAML-lite frontmatter parser. Supports single-line `key: value` pairs with
 * string/number/boolean/null scalars and inline lists (`[a, b]`). Anything
 * richer goes through the adapter `parser` option, keeping this package
 * dependency-free.
 */

export type YamlParser = (yaml: string) => Record<string, unknown>;

/** Parse a `---`-delimited frontmatter block. Returns the frontmatter and the remaining body. */
export function parseFrontmatter(raw: string, parser?: YamlParser): { frontmatter: Record<string, unknown>; body: string } {
  const head = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!head.startsWith("---\n") && !head.startsWith("---\r\n")) {
    return { frontmatter: {}, body: head };
  }
  const afterOpen = head.slice(head.indexOf("\n") + 1);
  // Closing `---` MUST be at the start of a line (end of file also closes).
  const closeMatch = afterOpen.match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: {}, body: head };
  }
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const frontmatter = parser ? parser(yamlText) : parseYamlLite(yamlText);
  return { frontmatter, body };
}

export function parseYamlLite(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
      else if (value.startsWith("#")) value = "";
    }
    out[key] = coerceValue(value);
  }
  return out;
}

function coerceValue(v: string): unknown {
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((s) => coerceScalar(s.trim()));
  }
  return coerceScalar(v);
}

function coerceScalar(v: string): unknown {
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    const inner = v.slice(1, -1);
    if (v.startsWith('"')) return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return inner;
  }
  return v;
}
