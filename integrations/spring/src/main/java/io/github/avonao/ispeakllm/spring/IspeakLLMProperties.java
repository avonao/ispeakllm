// New for the IspeakLLM OSS port (ispeakllm.* keys modeled on goplainly.llms-txt.* in integrations/spring/.../GoPlainlyLlmsTxtController.java, goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
package io.github.avonao.ispeakllm.spring;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** {@code ispeakllm.*} configuration. */
@ConfigurationProperties(prefix = "ispeakllm")
public class IspeakLLMProperties {

    /** Serve the bundle (default true). */
    private boolean enabled = true;

    /** Path of the bundle written by {@code ispeakllm generate}. */
    private String bundle = ".ispeakllm/bundle.json";

    /** Cache-Control for Markdown, llms.txt, the ACM and policy files. */
    private String cacheControl = BundleServer.DEFAULT_CACHE_CONTROL;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getBundle() { return bundle; }
    public void setBundle(String bundle) { this.bundle = bundle; }
    public String getCacheControl() { return cacheControl; }
    public void setCacheControl(String cacheControl) { this.cacheControl = cacheControl; }
}
