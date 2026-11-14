// New for the IspeakLLM OSS port (no tests in goplainly-v6-2026-11-10-current-dormant/integrations/aspnetcore)
// SPDX-License-Identifier: MIT
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using IspeakLLM.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace IspeakLLM.AspNetCore.Tests;

/// <summary>
/// Runs every "level": "core" case of conformance/adapter-http/cases.json against TestServer:
/// UseIspeakLLM() in front of the reference host. Same checks as runner.mjs.
/// </summary>
public sealed class ConformanceTests : IAsyncLifetime
{
    private static readonly string Conf = FindConf();
    private static readonly JsonElement Cases = JsonDocument.Parse(File.ReadAllText(Path.Combine(Conf, "cases.json"))).RootElement;
    private static readonly JsonElement Bundle = JsonDocument.Parse(File.ReadAllText(Path.Combine(Conf, "bundle.json"))).RootElement;
    private IHost? _host;
    private HttpClient? _client;

    private static string FindConf()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "conformance", "adapter-http"))) dir = dir.Parent;
        return dir is null ? throw new DirectoryNotFoundException("conformance/adapter-http") : Path.Combine(dir.FullName, "conformance", "adapter-http");
    }

    public async Task InitializeAsync()
    {
        _host = await new HostBuilder().ConfigureWebHost(web => web
            .UseTestServer()
            .ConfigureServices(s => s.AddIspeakLLM(o => o.BundlePath = Path.Combine(Conf, "bundle.json")))
            .Configure(app =>
            {
                app.UseIspeakLLM();
                // Reference host from cases.json `host`.
                app.Run(async ctx =>
                {
                    var missing = ctx.Request.Path.Value!.StartsWith("/no-such-page", StringComparison.Ordinal);
                    ctx.Response.StatusCode = missing ? 404 : 200;
                    ctx.Response.ContentType = "text/html; charset=utf-8";
                    await ctx.Response.WriteAsync(missing ? "<html>missing</html>" : "<html>host</html>");
                });
            })).StartAsync();
        _client = _host.GetTestClient();
    }

    public async Task DisposeAsync()
    {
        _client?.Dispose();
        if (_host is not null) await _host.StopAsync();
        _host?.Dispose();
    }

    public static IEnumerable<object[]> CoreCases() =>
        Cases.GetProperty("cases").EnumerateArray()
            .Where(c => c.GetProperty("level").GetString() == "core")
            .Select(c => new object[] { c.GetProperty("id").GetString()! });

    [Fact]
    public void CoreCaseCountIs19() => Assert.Equal(19, CoreCases().Count());

    private static string Fill(string v) =>
        Regex.Replace(v, @"\{etag:([^}]+)\}", m => Bundle.GetProperty("files").GetProperty(m.Groups[1].Value).GetProperty("etag").GetString()!);

    private static JsonElement BundleFile(string p) => Bundle.GetProperty("files").GetProperty(p);

    [Theory]
    [MemberData(nameof(CoreCases))]
    public async Task Case(string id)
    {
        var c = Cases.GetProperty("cases").EnumerateArray().First(x => x.GetProperty("id").GetString() == id);
        var rq = c.GetProperty("request");
        var method = rq.TryGetProperty("method", out var m) ? m.GetString()! : "GET";
        using var req = new HttpRequestMessage(new HttpMethod(method), rq.GetProperty("path").GetString());
        if (rq.TryGetProperty("headers", out var hs))
            foreach (var h in hs.EnumerateObject()) req.Headers.TryAddWithoutValidation(h.Name, Fill(h.Value.GetString()!));

        using var res = await _client!.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        var x = c.GetProperty("expect");

        string? Header(string name) =>
            res.Headers.TryGetValues(name, out var v1) ? string.Join(", ", v1)
            : res.Content.Headers.TryGetValues(name, out var v2) ? string.Join(", ", v2) : null;

        if (x.TryGetProperty("status", out var st)) Assert.Equal(st.GetInt32(), (int)res.StatusCode);
        if (x.TryGetProperty("headers", out var eh))
            foreach (var h in eh.EnumerateObject())
            {
                var got = Header(h.Name);
                Assert.True(got is not null && Regex.IsMatch(got, h.Value.GetString()!, RegexOptions.IgnoreCase), $"{id}: header {h.Name} = {got ?? "null"}");
            }
        if (x.TryGetProperty("bodyEqualsFile", out var bf)) Assert.Equal(BundleFile(bf.GetString()!).GetProperty("body").GetString(), body);
        if (x.TryGetProperty("etagEqualsFile", out var ef)) Assert.Equal(BundleFile(ef.GetString()!).GetProperty("etag").GetString(), Header("etag"));
        if (x.TryGetProperty("tokensEqualFile", out var tf)) Assert.Equal(BundleFile(tf.GetString()!).GetProperty("tokens").GetInt32().ToString(), Header("x-markdown-tokens"));
        if (x.TryGetProperty("bodyEqualsHost", out var bh) && bh.GetBoolean()) Assert.Equal(Cases.GetProperty("host").GetProperty("body").GetString(), body);
        if (x.TryGetProperty("bodyEmpty", out var be) && be.GetBoolean()) Assert.Equal("", body);
    }

    [Fact]
    public void VaryAcceptEncodingStillGetsAccept()
    {
        Assert.Equal("Accept-Encoding, Accept", BundleServer.MergeVary("Accept-Encoding"));
        Assert.Null(BundleServer.MergeVary("Origin, accept"));
    }

    [Fact]
    public void NegotiationTies()
    {
        Assert.Equal("md", BundleServer.Negotiate("/x", "text/markdown, text/html").Variant);
        Assert.Equal("html", BundleServer.Negotiate("/x", "text/html, text/markdown").Variant);
        Assert.Equal("/docs", BundleServer.Negotiate("/docs/index.md", null).PagePath);
    }
}
