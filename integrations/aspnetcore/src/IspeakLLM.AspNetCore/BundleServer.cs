// Ported from integrations/aspnetcore/src/GoPlainly.AspNetCore/Controllers/GoPlainlyLlmsTxtController.cs (goplainly-v6-2026-11-10-current-dormant); behaviour from packages/serve/src/index.ts + packages/core/src/negotiate.ts
// SPDX-License-Identifier: MIT
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace IspeakLLM.AspNetCore;

/// <summary>A bundle answer. Header names are lower-case.</summary>
public sealed record BundleResult(int Status, IReadOnlyDictionary<string, string> Headers, string Body);

/// <summary>Framework-independent IspeakLLM bundle server (System.Text.Json only).</summary>
public sealed class BundleServer
{
    public static readonly IReadOnlySet<string> PolicyPaths = new HashSet<string> { "/robots.txt", "/ai.txt", "/license.xml", "/.well-known/tdmrep.json", "/.well-known/jwks.json" };
    public const string AcmPath = "/.well-known/ai-conformance.json";
    public const string AcmType = "application/ai-conformance+json";
    public const string DefaultCacheControl = "public, max-age=300";
    private static readonly Regex Q = new(@"^\s*q\s*=\s*([0-9.]+)\s*$", RegexOptions.IgnoreCase);
    // A Vary token equal to Accept (or *); \baccept\b would also match Accept-Encoding.
    private static readonly Regex VaryAccept = new(@"(^|,)\s*(accept|\*)\s*(,|$)", RegexOptions.IgnoreCase);

    private readonly JsonElement _bundle;
    private readonly string _cacheControl;

    public BundleServer(JsonElement bundle, string? cacheControl = null)
    {
        if (bundle.ValueKind != JsonValueKind.Object
            || !bundle.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1
            || !bundle.TryGetProperty("files", out var f) || f.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("IspeakLLM: not a version 1 bundle");
        _bundle = bundle.Clone();
        _cacheControl = cacheControl ?? DefaultCacheControl;
    }

    public static BundleServer FromFile(string path, string? cacheControl = null)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
        return new BundleServer(doc.RootElement, cacheControl);
    }

    private JsonElement? FileAt(string p) =>
        _bundle.GetProperty("files").TryGetProperty(p, out var f) && f.ValueKind == JsonValueKind.Object ? f : null;

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";

    /// <summary>Answer from the bundle, or null to let the application answer.</summary>
    /// <param name="headers">Request headers with lower-case names.</param>
    public BundleResult? Handle(string method, string path, IReadOnlyDictionary<string, string> headers)
    {
        var m = (method ?? "GET").ToUpperInvariant();
        if (m != "GET" && m != "HEAD") return null;
        var head = m == "HEAD";

        if (PolicyPaths.Contains(path) && FileAt(path) is { } pf)
            return new BundleResult(200, new Dictionary<string, string> { ["content-type"] = Str(pf, "type"), ["cache-control"] = _cacheControl }, head ? "" : Str(pf, "body"));

        var (variant, page) = Negotiate(path, headers.TryGetValue("accept", out var a) ? a : null);
        switch (variant)
        {
            case "acm":
                if (FileAt(AcmPath) is not { } af) return null;
                return new BundleResult(200, new Dictionary<string, string> { ["content-type"] = AcmType, ["cache-control"] = _cacheControl, ["vary"] = "Accept" }, head ? "" : Str(af, "body"));
            case "llmstxt":
            case "llmsfull":
                return FileAt(variant == "llmstxt" ? "/llms.txt" : "/llms-full.txt") is { } lf ? Markdown(lf, headers, head, "/") : null;
            case "md":
                page = string.IsNullOrEmpty(page) ? "/" : page;
                if (FileAt(page == "/" ? "/index.md" : page + ".md") is { } mf) return Markdown(mf, headers, head, page);
                if (path.EndsWith(".md", StringComparison.Ordinal))
                    return new BundleResult(404, new Dictionary<string, string> { ["content-type"] = "text/plain; charset=utf-8", ["vary"] = "Accept" }, head ? "" : "No Markdown is published for this page.\n");
                return null; // Accept: text/markdown on a page we don't know: the app answers with HTML.
            default:
                return null;
        }
    }

    /// <summary>Headers for a human HTML page: vary, link (when the page's Markdown exists), policy headers.</summary>
    public IReadOnlyDictionary<string, string> DiscoveryHeaders(string pathname)
    {
        var h = new Dictionary<string, string> { ["vary"] = "Accept" };
        var md = pathname == "/" ? "/index.md" : pathname.TrimEnd('/') + ".md";
        if (FileAt(md) is not null)
            h["link"] = LinkHeaderValue(pathname, Str(_bundle, "origin") is { Length: > 0 } o ? o : null);
        foreach (var (k, v) in PathHeadersFor(pathname))
            if (v.Length > 0) h[k.ToLowerInvariant()] = v;
        return h;
    }

    /// <summary>New Vary value with Accept appended, or null when the current value already covers it.</summary>
    public static string? MergeVary(string? current) =>
        string.IsNullOrWhiteSpace(current) ? "Accept" : VaryAccept.IsMatch(current) ? null : current + ", Accept";

    /// <summary>Longest pathHeaders key prefixing the path ("/" by default).</summary>
    public IReadOnlyDictionary<string, string> PathHeadersFor(string pathname)
    {
        var outp = new Dictionary<string, string>();
        if (!_bundle.TryGetProperty("pathHeaders", out var ph) || ph.ValueKind != JsonValueKind.Object) return outp;
        var best = "/";
        foreach (var p in ph.EnumerateObject())
            if (pathname.StartsWith(p.Name, StringComparison.Ordinal) && p.Name.Length > best.Length) best = p.Name;
        if (ph.TryGetProperty(best, out var h) && h.ValueKind == JsonValueKind.Object)
            foreach (var p in h.EnumerateObject())
                if (p.Value.ValueKind == JsonValueKind.String) outp[p.Name] = p.Value.GetString()!;
        return outp;
    }

    private static string StripWeak(string t)
    {
        var s = t.Trim();
        return s.StartsWith("W/", StringComparison.Ordinal) ? s[2..] : s;
    }

    private BundleResult Markdown(JsonElement f, IReadOnlyDictionary<string, string> req, bool head, string policyPath)
    {
        var body = Str(f, "body");
        var etag = Str(f, "etag");
        if (etag.Length == 0) etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant()[..32] + "\"";
        var tokens = f.TryGetProperty("tokens", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : (Encoding.UTF8.GetByteCount(body) + 3) / 4;
        var type = Str(f, "type");
        var h = new Dictionary<string, string>
        {
            ["content-type"] = type.Length > 0 ? type : "text/markdown; charset=utf-8",
            ["vary"] = "Accept",
            ["x-markdown-tokens"] = tokens.ToString(CultureInfo.InvariantCulture),
            ["etag"] = etag,
            ["cache-control"] = _cacheControl,
        };
        foreach (var (k, v) in PathHeadersFor(policyPath))
            if (v.Length > 0) h[k.ToLowerInvariant()] = v;
        if (req.TryGetValue("if-none-match", out var inm))
        {
            var want = StripWeak(etag);
            foreach (var tag in inm.Split(','))
            {
                var s = StripWeak(tag);
                if (s == "*" || s == want) return new BundleResult(304, h, "");
            }
        }
        return new BundleResult(200, h, head ? "" : body);
    }

    public static string LinkHeaderValue(string pathname, string? origin)
    {
        var b = origin is null ? "" : origin.TrimEnd('/');
        var p = pathname.Length > 1 ? pathname.TrimEnd('/') : pathname;
        var md = p is "/" or "" ? "/index.md" : p + ".md";
        return $"<{b}{md}>; rel=\"alternate\"; type=\"text/markdown\", <{b}/llms.txt>; rel=\"describedby\"; type=\"text/markdown\"";
    }

    private sealed record Entry(string Type, double Q, int Index);

    private static List<Entry> ParseAccept(string? header)
    {
        var outp = new List<Entry>();
        if (string.IsNullOrEmpty(header)) return outp;
        var parts = header.Split(',');
        for (var i = 0; i < parts.Length; i++)
        {
            var pieces = parts[i].Split(';');
            var type = pieces[0].Trim().ToLowerInvariant();
            if (type.Length == 0) continue;
            double q = 1;
            foreach (var p in pieces.Skip(1))
            {
                var mm = Q.Match(p);
                if (mm.Success)
                    q = double.TryParse(mm.Groups[1].Value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var n) ? Math.Clamp(n, 0, 1) : 0;
            }
            outp.Add(new Entry(type, q, i));
        }
        return outp;
    }

    /// <summary>Port of @ispeakllm/core negotiate() (without locales). Returns the variant and, for md, the page path.</summary>
    public static (string Variant, string? PagePath) Negotiate(string path, string? accept)
    {
        if (path == AcmPath) return ("acm", null);
        if (path == "/llms.txt") return ("llmstxt", null);
        if (path == "/llms-full.txt") return ("llmsfull", null);
        if (path.EndsWith(".md", StringComparison.Ordinal))
        {
            var page = path[..^3];
            if (page is "" or "/index") page = "/";
            else if (page.EndsWith("/index", StringComparison.Ordinal)) page = page[..^6] is { Length: > 0 } s ? s : "/";
            return ("md", page);
        }
        var entries = ParseAccept(accept);
        Entry? Find(string t) => entries.FirstOrDefault(e => e.Type == t);
        var acm = Find(AcmType);
        var md = Find("text/markdown");
        var html = Find("text/html") ?? Find("text/*") ?? Find("*/*");
        var cands = new List<(string V, double Q, int Rank, int Index)>();
        if (acm is { Q: > 0 }) cands.Add(("acm", acm.Q, 0, acm.Index));
        if (md is { Q: > 0 }) cands.Add(("md", md.Q, 1, md.Index));
        if (html is { Q: > 0 }) cands.Add(("html", html.Q, 1, html.Index));
        var best = cands.OrderByDescending(c => c.Q).ThenBy(c => c.Rank).ThenBy(c => c.Index).Select(c => c.V).FirstOrDefault();
        if (best == "acm") return ("acm", null);
        if (best == "md") return ("md", path.EndsWith('/') && path != "/" ? path[..^1] : path);
        return ("html", null);
    }
}
