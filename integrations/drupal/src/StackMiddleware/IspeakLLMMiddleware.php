<?php
// Ported from integrations/drupal/src/Controller/LlmsTxtController.php (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Drupal\ispeakllm\StackMiddleware;

use Drupal\Core\Site\Settings;
use IspeakLLM\Core\BundleServer;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;

if (!class_exists(BundleServer::class)) {
  require_once __DIR__ . '/../../core/BundleServer.php';
}

/**
 * HTTP middleware (runs before the page cache): answers agent requests from the
 * iSpeakLLM bundle and adds `Vary: Accept`, `Link` and policy headers to HTML pages.
 *
 * Settings (settings.php):
 *   $settings['ispeakllm_bundle'] = '/path/to/.ispeakllm/bundle.json';
 *   $settings['ispeakllm_cache_control'] = 'public, max-age=300';
 *   $settings['ispeakllm_enabled'] = TRUE;
 */
final class IspeakLLMMiddleware implements HttpKernelInterface {

  private ?BundleServer $server = NULL;
  private bool $loaded = FALSE;

  public function __construct(private readonly HttpKernelInterface $httpKernel) {}

  /**
   * {@inheritdoc}
   */
  public function handle(Request $request, int $type = self::MAIN_REQUEST, bool $catch = TRUE): Response {
    $server = $type === self::MAIN_REQUEST ? $this->server() : NULL;
    if ($server === NULL) {
      return $this->httpKernel->handle($request, $type, $catch);
    }

    $path = rawurldecode('/' . ltrim($request->getPathInfo(), '/'));
    $headers = [];
    foreach ($request->headers->all() as $name => $values) {
      $headers[strtolower((string) $name)] = implode(', ', (array) $values);
    }

    $res = $server->handle(['method' => $request->getMethod(), 'path' => $path, 'headers' => $headers]);
    if ($res !== NULL) {
      return new Response($res['body'], $res['status'], $res['headers']);
    }

    $response = $this->httpKernel->handle($request, $type, $catch);
    if (str_contains((string) $response->headers->get('Content-Type', ''), 'text/html')) {
      $current = [];
      foreach (['vary', 'link'] as $h) {
        if ($response->headers->has($h)) {
          $current[$h] = implode(', ', $response->headers->all($h));
        }
      }
      foreach (BundleServer::mergeDiscovery($current, $server->discoveryHeaders($path)) as $name => $value) {
        $response->headers->set($name, $value);
      }
    }
    return $response;
  }

  private function server(): ?BundleServer {
    if (!$this->loaded) {
      $this->loaded = TRUE;
      if (!Settings::get('ispeakllm_enabled', TRUE)) {
        return NULL;
      }
      $path = (string) Settings::get('ispeakllm_bundle', dirname(DRUPAL_ROOT) . '/.ispeakllm/bundle.json');
      try {
        $this->server = BundleServer::fromFile($path, (string) Settings::get('ispeakllm_cache_control', 'public, max-age=300'));
      }
      catch (\Throwable $e) {
        // No bundle yet: Drupal answers everything itself.
        $this->server = NULL;
      }
    }
    return $this->server;
  }

}
