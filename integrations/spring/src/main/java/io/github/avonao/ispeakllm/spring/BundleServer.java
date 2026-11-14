// Ported from integrations/spring/src/main/java/com/goplainly/spring/GoPlainlyLlmsTxtController.java (goplainly-v6-2026-11-10-current-dormant); behaviour from packages/serve/src/index.ts + packages/core/src/negotiate.ts
// SPDX-License-Identifier: MIT
package io.github.avonao.ispeakllm.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Framework-independent IspeakLLM bundle server. Needs only Jackson (already on a Spring Boot
 * web classpath). {@link #handle} answers agent requests; {@link #discoveryHeaders} decorates HTML.
 */
public final class BundleServer {

    public static final Set<String> POLICY_PATHS = Set.of("/robots.txt", "/ai.txt", "/license.xml", "/.well-known/tdmrep.json", "/.well-known/jwks.json");
    public static final String ACM_PATH = "/.well-known/ai-conformance.json";
    public static final String ACM_TYPE = "application/ai-conformance+json";
    public static final String DEFAULT_CACHE_CONTROL = "public, max-age=300";
    private static final Pattern Q = Pattern.compile("^\\s*q\\s*=\\s*([0-9.]+)\\s*$", Pattern.CASE_INSENSITIVE);
    /** A Vary token equal to Accept (or *); {@code \baccept\b} would also match Accept-Encoding. */
    private static final Pattern VARY_ACCEPT = Pattern.compile("(^|,)\\s*(accept|\\*)\\s*(,|$)", Pattern.CASE_INSENSITIVE);

    /** A bundle answer. Header names are lower-case. */
    public record Result(int status, Map<String, String> headers, String body) {}

    /** Negotiation verdict. {@code pagePath} is set for {@code md}. */
    public record Verdict(String variant, String pagePath) {}

    private final JsonNode bundle;
    private final String cacheControl;

    public BundleServer(JsonNode bundle, String cacheControl) {
        if (bundle == null || bundle.path("version").asInt() != 1 || !bundle.path("files").isObject()) {
            throw new IllegalArgumentException("IspeakLLM: not a version 1 bundle");
        }
        this.bundle = bundle;
        this.cacheControl = cacheControl == null ? DEFAULT_CACHE_CONTROL : cacheControl;
    }

    public static BundleServer fromFile(Path path, String cacheControl) throws IOException {
        return new BundleServer(new ObjectMapper().readTree(Files.readString(path, StandardCharsets.UTF_8)), cacheControl);
    }

    private JsonNode file(String p) {
        JsonNode f = bundle.path("files").get(p);
        return f != null && f.isObject() ? f : null;
    }

    /**
     * @param headers request headers, lower-case names
     * @return the answer, or {@code null} to let the application answer
     */
    public Result handle(String method, String path, Map<String, String> headers) {
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        if (!m.equals("GET") && !m.equals("HEAD")) return null;
        boolean head = m.equals("HEAD");

        JsonNode f;
        if (POLICY_PATHS.contains(path) && (f = file(path)) != null) {
            Map<String, String> h = new LinkedHashMap<>();
            h.put("content-type", f.path("type").asText());
            h.put("cache-control", cacheControl);
            return new Result(200, h, head ? "" : f.path("body").asText());
        }

        Verdict v = negotiate(path, headers.get("accept"));
        switch (v.variant()) {
            case "acm": {
                f = file(ACM_PATH);
                if (f == null) return null;
                Map<String, String> h = new LinkedHashMap<>();
                h.put("content-type", ACM_TYPE);
                h.put("cache-control", cacheControl);
                h.put("vary", "Accept");
                return new Result(200, h, head ? "" : f.path("body").asText());
            }
            case "llmstxt":
            case "llmsfull": {
                f = file(v.variant().equals("llmstxt") ? "/llms.txt" : "/llms-full.txt");
                return f == null ? null : markdown(f, headers, head, "/");
            }
            case "md": {
                String page = v.pagePath() == null || v.pagePath().isEmpty() ? "/" : v.pagePath();
                f = file(page.equals("/") ? "/index.md" : page + ".md");
                if (f != null) return markdown(f, headers, head, page);
                if (path.endsWith(".md")) {
                    Map<String, String> h = new LinkedHashMap<>();
                    h.put("content-type", "text/plain; charset=utf-8");
                    h.put("vary", "Accept");
                    return new Result(404, h, head ? "" : "No Markdown is published for this page.\n");
                }
                return null; // Accept: text/markdown on a page we don't know: the app answers with HTML.
            }
            default:
                return null;
        }
    }

    /** Headers for a human HTML page: vary, link (when the page's Markdown exists), policy headers. */
    public Map<String, String> discoveryHeaders(String pathname) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("vary", "Accept");
        String md = pathname.equals("/") ? "/index.md" : pathname.replaceAll("/+$", "") + ".md";
        if (file(md) != null) {
            JsonNode origin = bundle.get("origin");
            h.put("link", linkHeaderValue(pathname, origin != null && origin.isTextual() ? origin.asText() : null));
        }
        pathHeadersFor(pathname).forEach((k, val) -> { if (!val.isEmpty()) h.put(k.toLowerCase(Locale.ROOT), val); });
        return h;
    }

    /** New Vary value with Accept appended, or {@code null} when the current value already covers it. */
    public static String mergeVary(String current) {
        if (current == null || current.isBlank()) return "Accept";
        return VARY_ACCEPT.matcher(current).find() ? null : current + ", Accept";
    }

    /** Longest {@code pathHeaders} key prefixing the path ({@code "/"} by default). */
    public Map<String, String> pathHeadersFor(String pathname) {
        JsonNode ph = bundle.get("pathHeaders");
        Map<String, String> out = new LinkedHashMap<>();
        if (ph == null || !ph.isObject()) return out;
        String best = "/";
        for (Iterator<String> it = ph.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (pathname.startsWith(k) && k.length() > best.length()) best = k;
        }
        JsonNode h = ph.get(best);
        if (h != null && h.isObject()) h.fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().asText()));
        return out;
    }

    private static String stripWeak(String t) {
        String s = t.trim();
        return s.startsWith("W/") ? s.substring(2) : s;
    }

    private Result markdown(JsonNode f, Map<String, String> req, boolean head, String policyPath) {
        String body = f.path("body").asText();
        String etag = f.hasNonNull("etag") ? f.get("etag").asText() : "\"" + sha256Hex(body).substring(0, 32) + "\"";
        int bytes = body.getBytes(StandardCharsets.UTF_8).length;
        long tokens = f.hasNonNull("tokens") ? f.get("tokens").asLong() : (bytes + 3) / 4;
        Map<String, String> h = new LinkedHashMap<>();
        h.put("content-type", f.hasNonNull("type") ? f.get("type").asText() : "text/markdown; charset=utf-8");
        h.put("vary", "Accept");
        h.put("x-markdown-tokens", Long.toString(tokens));
        h.put("etag", etag);
        h.put("cache-control", cacheControl);
        pathHeadersFor(policyPath).forEach((k, val) -> { if (!val.isEmpty()) h.put(k.toLowerCase(Locale.ROOT), val); });
        String inm = req.get("if-none-match");
        if (inm != null) {
            String want = stripWeak(etag);
            for (String t : inm.split(",", -1)) {
                String s = stripWeak(t);
                if (s.equals("*") || s.equals(want)) return new Result(304, h, "");
            }
        }
        return new Result(200, h, head ? "" : body);
    }

    private static String sha256Hex(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String linkHeaderValue(String pathname, String origin) {
        String base = origin == null ? "" : origin.replaceAll("/+$", "");
        String p = pathname.length() > 1 ? pathname.replaceAll("/+$", "") : pathname;
        String md = p.equals("/") || p.isEmpty() ? "/index.md" : p + ".md";
        return "<" + base + md + ">; rel=\"alternate\"; type=\"text/markdown\", <" + base + "/llms.txt>; rel=\"describedby\"; type=\"text/markdown\"";
    }

    private record Entry(String type, double q, int index) {}

    static List<Entry> parseAccept(String header) {
        List<Entry> out = new ArrayList<>();
        if (header == null || header.isEmpty()) return out;
        String[] parts = header.split(",", -1);
        for (int i = 0; i < parts.length; i++) {
            String[] pieces = parts[i].split(";", -1);
            String type = pieces[0].trim().toLowerCase(Locale.ROOT);
            if (type.isEmpty()) continue;
            double q = 1;
            for (int j = 1; j < pieces.length; j++) {
                Matcher mm = Q.matcher(pieces[j]);
                if (mm.matches()) {
                    try {
                        q = Math.min(1, Math.max(0, Double.parseDouble(mm.group(1))));
                    } catch (NumberFormatException e) {
                        q = 0;
                    }
                }
            }
            out.add(new Entry(type, q, i));
        }
        return out;
    }

    /** Port of {@code @ispeakllm/core} {@code negotiate()} (without locales). */
    public static Verdict negotiate(String path, String accept) {
        if (path.equals(ACM_PATH)) return new Verdict("acm", null);
        if (path.equals("/llms.txt")) return new Verdict("llmstxt", null);
        if (path.equals("/llms-full.txt")) return new Verdict("llmsfull", null);
        if (path.endsWith(".md")) {
            String page = path.substring(0, path.length() - 3);
            if (page.isEmpty() || page.equals("/index")) page = "/";
            else if (page.endsWith("/index")) {
                page = page.substring(0, page.length() - 6);
                if (page.isEmpty()) page = "/";
            }
            return new Verdict("md", page);
        }
        List<Entry> entries = parseAccept(accept);
        Entry acm = find(entries, ACM_TYPE), md = find(entries, "text/markdown");
        Entry html = find(entries, "text/html");
        if (html == null) html = find(entries, "text/*");
        if (html == null) html = find(entries, "*/*");
        record Cand(String variant, double q, int rank, int index) {}
        List<Cand> cands = new ArrayList<>();
        if (acm != null && acm.q() > 0) cands.add(new Cand("acm", acm.q(), 0, acm.index()));
        if (md != null && md.q() > 0) cands.add(new Cand("md", md.q(), 1, md.index()));
        if (html != null && html.q() > 0) cands.add(new Cand("html", html.q(), 1, html.index()));
        cands.sort(Comparator.comparingDouble((Cand c) -> -c.q()).thenComparingInt(Cand::rank).thenComparingInt(Cand::index));
        if (!cands.isEmpty() && cands.get(0).variant().equals("acm")) return new Verdict("acm", null);
        if (!cands.isEmpty() && cands.get(0).variant().equals("md")) {
            String page = path.endsWith("/") && !path.equals("/") ? path.substring(0, path.length() - 1) : path;
            return new Verdict("md", page);
        }
        return new Verdict("html", null);
    }

    private static Entry find(List<Entry> entries, String type) {
        for (Entry e : entries) if (e.type().equals(type)) return e;
        return null;
    }
}
