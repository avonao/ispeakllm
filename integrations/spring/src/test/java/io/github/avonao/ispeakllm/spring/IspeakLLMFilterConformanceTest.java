// Ported from integrations/spring/src/test/java/com/goplainly/spring/GoPlainlyLlmsTxtControllerTest.java (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
package io.github.avonao.ispeakllm.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * Runs every {@code "level": "core"} case of conformance/adapter-http/cases.json through MockMvc:
 * the filter in front of the reference host controller. Same checks as runner.mjs.
 */
class IspeakLLMFilterConformanceTest {

    static final Path CONF = Path.of("../../conformance/adapter-http");
    static JsonNode cases;
    static JsonNode bundle;
    static MockMvc mvc;

    /** Reference host from cases.json {@code host}. */
    @RestController
    static class HostController {
        @RequestMapping("/**")
        ResponseEntity<String> any(HttpServletRequest req) {
            boolean missing = IspeakLLMFilter.sitePath(req).startsWith("/no-such-page");
            return ResponseEntity.status(missing ? 404 : 200)
                    .contentType(MediaType.parseMediaType("text/html; charset=utf-8"))
                    .body(missing ? "<html>missing</html>" : "<html>host</html>");
        }
    }

    @BeforeAll
    static void setUp() throws Exception {
        ObjectMapper om = new ObjectMapper();
        cases = om.readTree(Files.readString(CONF.resolve("cases.json")));
        bundle = om.readTree(Files.readString(CONF.resolve("bundle.json")));
        BundleServer server = new BundleServer(bundle, null);
        mvc = MockMvcBuilders.standaloneSetup(new HostController()).addFilters(new IspeakLLMFilter(server)).build();
    }

    static String fill(String v) {
        Matcher m = Pattern.compile("\\{etag:([^}]+)\\}").matcher(v);
        StringBuilder sb = new StringBuilder();
        while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement(bundle.path("files").path(m.group(1)).path("etag").asText()));
        m.appendTail(sb);
        return sb.toString();
    }

    @TestFactory
    List<DynamicTest> coreCases() {
        List<DynamicTest> out = new ArrayList<>();
        for (JsonNode c : cases.path("cases")) {
            if (!"core".equals(c.path("level").asText())) continue;
            out.add(DynamicTest.dynamicTest(c.path("id").asText(), () -> runCase(c)));
        }
        assertEquals(19, out.size(), "core case count changed");
        return out;
    }

    void runCase(JsonNode c) throws Exception {
        JsonNode rq = c.path("request");
        MockHttpServletRequestBuilder b = request(HttpMethod.valueOf(rq.path("method").asText("GET")), rq.path("path").asText());
        for (Iterator<Map.Entry<String, JsonNode>> it = rq.path("headers").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            b.header(e.getKey(), fill(e.getValue().asText()));
        }
        MockHttpServletResponse res = mvc.perform(b).andReturn().getResponse();
        String body = res.getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        JsonNode x = c.path("expect");
        String id = c.path("id").asText();

        if (x.has("status")) assertEquals(x.get("status").asInt(), res.getStatus(), id + " status");
        for (Iterator<Map.Entry<String, JsonNode>> it = x.path("headers").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            List<String> values = res.getHeaders(e.getKey());
            assertTrue(!values.isEmpty(), id + " header " + e.getKey() + " missing");
            String got = String.join(", ", values);
            assertTrue(Pattern.compile(e.getValue().asText(), Pattern.CASE_INSENSITIVE).matcher(got).find(), id + " header " + e.getKey() + ": " + got);
        }
        if (x.has("bodyEqualsFile")) assertEquals(bundle.path("files").path(x.get("bodyEqualsFile").asText()).path("body").asText(), body, id + " body");
        if (x.has("etagEqualsFile")) assertEquals(bundle.path("files").path(x.get("etagEqualsFile").asText()).path("etag").asText(), res.getHeader("etag"), id + " etag");
        if (x.has("tokensEqualFile")) assertEquals(bundle.path("files").path(x.get("tokensEqualFile").asText()).path("tokens").asText(), res.getHeader("x-markdown-tokens"), id + " tokens");
        if (x.path("bodyEqualsHost").asBoolean(false)) assertEquals(cases.path("host").path("body").asText(), body, id + " host body");
        if (x.path("bodyEmpty").asBoolean(false)) assertEquals("", body, id + " body not empty");
    }

    @Test
    void varyAcceptEncodingStillGetsAccept() {
        assertEquals("Accept-Encoding, Accept", BundleServer.mergeVary("Accept-Encoding"));
        assertEquals(null, BundleServer.mergeVary("Origin, accept"));
        assertNotNull(BundleServer.mergeVary(""));
    }

    @Test
    void negotiationTies() {
        assertEquals("md", BundleServer.negotiate("/x", "text/markdown, text/html").variant());
        assertEquals("html", BundleServer.negotiate("/x", "text/html, text/markdown").variant());
        assertEquals("/docs", BundleServer.negotiate("/docs/index.md", null).pagePath());
    }
}
