// New for the IspeakLLM OSS port (no auto-configuration in goplainly-v6-2026-11-10-current-dormant/integrations/spring)
// SPDX-License-Identifier: MIT
package io.github.avonao.ispeakllm.spring;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;

import java.io.IOException;
import java.nio.file.Path;

/** Registers {@link IspeakLLMFilter} first in the servlet filter chain. */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnProperty(prefix = "ispeakllm", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(IspeakLLMProperties.class)
public class IspeakLLMAutoConfiguration {

    @Bean
    public FilterRegistrationBean<IspeakLLMFilter> ispeakllmFilter(IspeakLLMProperties props) throws IOException {
        BundleServer server = BundleServer.fromFile(Path.of(props.getBundle()), props.getCacheControl());
        FilterRegistrationBean<IspeakLLMFilter> reg = new FilterRegistrationBean<>(new IspeakLLMFilter(server));
        reg.addUrlPatterns("/*");
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
        reg.setName("ispeakllmFilter");
        return reg;
    }
}
