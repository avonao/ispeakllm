// Ported from integrations/spring/src/main/java/com/goplainly/spring/GoPlainlyLlmsTxtController.java (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
package io.github.avonao.ispeakllm.spring;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UriUtils;

import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Servlet filter: answers agent requests from the bundle; for the application's HTML responses
 * adds {@code Vary: Accept}, {@code Link} and policy headers the moment the HTML content type is set
 * (so streaming responses are not buffered). The body is never changed.
 */
public class IspeakLLMFilter extends OncePerRequestFilter {

    private final BundleServer server;

    public IspeakLLMFilter(BundleServer server) {
        this.server = server;
    }

    static String sitePath(HttpServletRequest req) {
        String uri = req.getRequestURI();
        String ctx = req.getContextPath();
        if (ctx != null && !ctx.isEmpty() && uri.startsWith(ctx)) uri = uri.substring(ctx.length());
        String p = UriUtils.decode(uri, StandardCharsets.UTF_8);
        return p.isEmpty() ? "/" : p;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String path = sitePath(req);
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : Collections.list(req.getHeaderNames())) {
            headers.put(name.toLowerCase(Locale.ROOT), String.join(", ", Collections.list(req.getHeaders(name))));
        }
        BundleServer.Result r = server.handle(req.getMethod(), path, headers);
        if (r != null) {
            res.setStatus(r.status());
            r.headers().forEach(res::setHeader);
            if (!r.body().isEmpty()) {
                byte[] bytes = r.body().getBytes(StandardCharsets.UTF_8);
                res.setContentLength(bytes.length);
                res.getOutputStream().write(bytes);
            }
            return;
        }
        Decorating wrapped = new Decorating(res, server, path);
        chain.doFilter(req, wrapped);
        if (!res.isCommitted()) wrapped.maybe(res.getContentType());
    }

    /** Applies discovery headers once, when the response turns out to be HTML. */
    static final class Decorating extends HttpServletResponseWrapper {
        private final BundleServer server;
        private final String path;
        private boolean done;

        Decorating(HttpServletResponse res, BundleServer server, String path) {
            super(res);
            this.server = server;
            this.path = path;
        }

        void maybe(String contentType) {
            if (done || contentType == null || !contentType.contains("text/html")) return;
            done = true;
            HttpServletResponse res = (HttpServletResponse) getResponse();
            server.discoveryHeaders(path).forEach((k, v) -> {
                switch (k) {
                    case "vary" -> {
                        String merged = BundleServer.mergeVary(String.join(", ", res.getHeaders("Vary")));
                        if (merged != null) res.setHeader("Vary", merged);
                    }
                    case "link" -> res.addHeader("Link", v);
                    default -> res.setHeader(k, v);
                }
            });
        }

        @Override public void setContentType(String type) { super.setContentType(type); maybe(type); }
        @Override public void setHeader(String name, String value) { super.setHeader(name, value); if ("content-type".equalsIgnoreCase(name)) maybe(value); }
        @Override public void addHeader(String name, String value) { super.addHeader(name, value); if ("content-type".equalsIgnoreCase(name)) maybe(value); }
        @Override public ServletOutputStream getOutputStream() throws IOException { maybe(getContentType()); return super.getOutputStream(); }
        @Override public PrintWriter getWriter() throws IOException { maybe(getContentType()); return super.getWriter(); }
        @Override public void flushBuffer() throws IOException { maybe(getContentType()); super.flushBuffer(); }
    }
}
