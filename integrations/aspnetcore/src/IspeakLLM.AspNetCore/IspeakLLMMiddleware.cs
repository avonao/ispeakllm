// Ported from integrations/aspnetcore/src/GoPlainly.AspNetCore/Controllers/GoPlainlyLlmsTxtController.cs (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace IspeakLLM.AspNetCore;

/// <summary>Options: <c>services.AddIspeakLLM(o =&gt; o.BundlePath = ".ispeakllm/bundle.json")</c> or the <c>iSpeakLLM</c> config section.</summary>
public sealed class IspeakLLMOptions
{
    public string BundlePath { get; set; } = ".ispeakllm/bundle.json";
    public string CacheControl { get; set; } = BundleServer.DefaultCacheControl;
}

/// <summary>
/// Answers agent requests from the bundle; for the app's HTML responses adds Vary: Accept, Link and
/// policy headers in <c>OnStarting</c> (no buffering; the body is untouched).
/// </summary>
public sealed class IspeakLLMMiddleware
{
    private readonly RequestDelegate _next;
    private readonly BundleServer _server;

    public IspeakLLMMiddleware(RequestDelegate next, BundleServer server)
    {
        _next = next;
        _server = server;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.PathBase.Value + ctx.Request.Path.Value; // already decoded by the server
        if (path.Length == 0) path = "/";
        var headers = new Dictionary<string, string>();
        foreach (var (k, v) in ctx.Request.Headers) headers[k.ToLowerInvariant()] = v.ToString();

        var r = _server.Handle(ctx.Request.Method, path, headers);
        if (r is not null)
        {
            ctx.Response.StatusCode = r.Status;
            foreach (var (k, v) in r.Headers) ctx.Response.Headers[k] = v;
            if (r.Body.Length > 0)
            {
                var bytes = Encoding.UTF8.GetBytes(r.Body);
                ctx.Response.ContentLength = bytes.Length;
                await ctx.Response.Body.WriteAsync(bytes, ctx.RequestAborted);
            }
            return;
        }

        ctx.Response.OnStarting(() =>
        {
            var res = ctx.Response;
            if (res.ContentType is { } ct && ct.Contains("text/html", StringComparison.Ordinal))
            {
                foreach (var (k, v) in _server.DiscoveryHeaders(path))
                {
                    if (k == "vary")
                    {
                        var merged = BundleServer.MergeVary(res.Headers.Vary.ToString());
                        if (merged is not null) res.Headers.Vary = merged;
                    }
                    else if (k == "link") res.Headers.Append("Link", v);
                    else res.Headers[k] = v;
                }
            }
            return Task.CompletedTask;
        });
        await _next(ctx);
    }
}

public static class IspeakLLMExtensions
{
    /// <summary>Register the bundle server (loaded once from <see cref="IspeakLLMOptions.BundlePath"/>).</summary>
    public static IServiceCollection AddIspeakLLM(this IServiceCollection services, Action<IspeakLLMOptions>? configure = null)
    {
        var builder = services.AddOptions<IspeakLLMOptions>().BindConfiguration("iSpeakLLM");
        if (configure is not null) builder.Configure(configure);
        services.AddSingleton(sp =>
        {
            var o = sp.GetRequiredService<IOptions<IspeakLLMOptions>>().Value;
            return BundleServer.FromFile(o.BundlePath, o.CacheControl);
        });
        return services;
    }

    /// <summary>Mount early, before static files and routing: <c>app.UseIspeakLLM();</c></summary>
    public static IApplicationBuilder UseIspeakLLM(this IApplicationBuilder app) => app.UseMiddleware<IspeakLLMMiddleware>();
}
