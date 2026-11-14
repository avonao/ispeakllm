# llms.txt extensions: languages, audience views, context export

IspeakLLM emits plain [llms.txt](https://llmstxt.org/) (H1, `>` summary, optional details, H2 file lists,
`## Optional`). The extensions below stay inside that grammar, so any llms.txt reader still parses the files.

## 1. Per-page Markdown
Each page is served at `<path>.md` (`/` → `/index.md`) and by `Accept: text/markdown` on the page URL. A page file
opens with `# <title>`, then `> <summary>` when there is one, then the body. A leading body H1 equal to the title
is not repeated.

## 2. Languages
Each locale has its own files under a prefix: the default locale at `/llms.txt`, others at `/<locale>/llms.txt`,
`/<locale>/llms-full.txt` and `/<locale>/<path>.md`. Each llms.txt lists the other locales in a `## Languages`
section, placed before `## Optional`:

```markdown
## Languages

- [Deutsch](/de/llms.txt): alternate (de) llms.txt
- [Français](/fr/llms.txt): alternate (fr) llms.txt
```

HTML pages advertise other-language versions in the `link` header with `hreflang`
(`</de/about>; rel="alternate"; hreflang="de"`). API: `generateLocales()` in `@ispeakllm/core`.

## 3. Audience views
A view is a filtered index for one audience or set of sections, served at `/views/<name>/llms.txt` and
`/views/<name>/llms-full.txt`. Pages carry `audience: [developers]` in frontmatter; a page with no audience is in every
view. Views link to the canonical page `.md` files, so pages are never duplicated. API: `generateViews()`.

## 4. Context export (llms-ctx)
`exportCtx()` expands the index into one context document in the shape of llmstxt.org's `llms_txt2ctx`
(`<project><section><doc …>…</doc></section><optional>…</optional></project>`), optionally within a token
budget: whole documents are added in index order while they fit.

## 5. Headers
Markdown responses carry `x-markdown-tokens` (ceil(UTF-8 bytes / 4)), the same header Cloudflare's Markdown for
Agents uses, so clients can budget before reading.

Examples: [conformance/core-site/golden](../../conformance/core-site/golden).
