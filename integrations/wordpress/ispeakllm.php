<?php
// Ported from integrations/wordpress/includes/class-goplainly-llmstxt.php (goplainly-v6-2026-11-10-current-dormant)
/**
 * Plugin Name:       IspeakLLM
 * Description:       Serves your IspeakLLM bundle: llms.txt, llms-full.txt, page Markdown (`.md` and `Accept: text/markdown`), the AI Conformance Manifest, policy files and headers.
 * Version:           0.1.0
 * Requires PHP:      8.1
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       ispeakllm
 *
 * @package IspeakLLM
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/core/BundleServer.php';

use IspeakLLM\Core\BundleServer;

/**
 * Bundle path: the ISPEAKLLM_BUNDLE constant (wp-config.php), else the `ispeakllm_bundle_path`
 * option, else `.ispeakllm/bundle.json` in the WordPress root. Filter: `ispeakllm_bundle_path`.
 */
function ispeakllm_bundle_path(): string
{
    $path = defined('ISPEAKLLM_BUNDLE') ? (string) ISPEAKLLM_BUNDLE : (string) get_option('ispeakllm_bundle_path', '');
    if ($path === '') {
        $path = ABSPATH . '.ispeakllm/bundle.json';
    }
    return (string) apply_filters('ispeakllm_bundle_path', $path);
}

function ispeakllm_server(): ?BundleServer
{
    static $server = false;
    if ($server === false) {
        try {
            $server = BundleServer::fromFile(ispeakllm_bundle_path());
        } catch (\Throwable $e) {
            $server = null; // No bundle yet: WordPress behaves as if the plugin were off.
        }
    }
    return $server;
}

/** The decoded request path, relative to the site root (subdirectory installs are stripped). */
function ispeakllm_request_path(): string
{
    $path = rawurldecode((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));
    $base = (string) parse_url(home_url('/'), PHP_URL_PATH);
    if ($base !== '' && $base !== '/' && str_starts_with($path, rtrim($base, '/'))) {
        $path = substr($path, strlen(rtrim($base, '/'))) ?: '/';
    }
    return $path;
}

/**
 * Agent variants are answered before WordPress routes the request (so `/robots.txt`,
 * `/llms.txt` and `/x.md` never reach the theme): `init`, priority 0.
 */
add_action('init', static function (): void {
    $server = ispeakllm_server();
    if (!$server || is_admin() || (defined('REST_REQUEST') && REST_REQUEST)) {
        return;
    }
    $headers = [];
    foreach ($_SERVER as $k => $v) {
        if (str_starts_with((string) $k, 'HTTP_')) {
            $headers[strtolower(str_replace('_', '-', substr((string) $k, 5)))] = (string) $v;
        }
    }
    $method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $res = $server->handle(['method' => $method, 'path' => ispeakllm_request_path(), 'headers' => $headers]);
    if ($res === null) {
        return;
    }
    status_header($res['status']);
    foreach ($res['headers'] as $name => $value) {
        header($name . ': ' . $value);
    }
    if ($method !== 'HEAD' && $res['status'] !== 304) {
        echo $res['body']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- bundle file, content-type fixed.
    }
    exit;
}, 0);

/** Human HTML pages: add Vary: Accept, Link to the page's Markdown and the policy headers. */
add_filter('wp_headers', static function (array $headers): array {
    $server = ispeakllm_server();
    if (!$server || is_admin()) {
        return $headers;
    }
    $res = $server->decorate(ispeakllm_request_path(), ['status' => 200, 'headers' => $headers + ['Content-Type' => (string) get_option('html_type', 'text/html') . '; charset=' . get_option('blog_charset', 'UTF-8')]]);
    $out = $res['headers'];
    // Keep WordPress's own header-name casing for what it already set.
    foreach ($headers as $name => $value) {
        if (isset($out[strtolower((string) $name)])) {
            $headers[$name] = $out[strtolower((string) $name)];
            unset($out[strtolower((string) $name)]);
        }
    }
    unset($out['content-type']);
    return $headers + $out;
});
