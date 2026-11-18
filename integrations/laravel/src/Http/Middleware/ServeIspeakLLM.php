<?php
// Ported from integrations/laravel/src/Http/Controllers/LlmsTxtController.php (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace IspeakLLM\Laravel\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use IspeakLLM\Core\BundleServer;
use Symfony\Component\HttpFoundation\Response;

/**
 * Global middleware: answers agent requests from the iSpeakLLM bundle, and adds
 * `Vary: Accept`, `Link` and policy headers to the app's HTML responses.
 */
final class ServeIspeakLLM
{
    private static ?BundleServer $server = null;
    private static ?string $loadedFrom = null;

    public function handle(Request $request, Closure $next): Response
    {
        $server = $this->server();
        if ($server === null) {
            return $next($request);
        }

        $path = rawurldecode('/' . ltrim($request->getPathInfo(), '/'));
        $headers = [];
        foreach ($request->headers->all() as $name => $values) {
            $headers[strtolower((string) $name)] = implode(', ', (array) $values);
        }

        $res = $server->handle(['method' => $request->getMethod(), 'path' => $path, 'headers' => $headers]);
        if ($res !== null) {
            return new Response($res['body'], $res['status'], $res['headers']);
        }

        /** @var Response $response */
        $response = $next($request);
        $type = (string) $response->headers->get('Content-Type', '');
        if (str_contains($type, 'text/html')) {
            $current = [];
            foreach (['vary', 'link'] as $h) {
                if ($response->headers->has($h)) {
                    $current[$h] = implode(', ', $response->headers->all($h));
                }
            }
            $merged = BundleServer::mergeDiscovery($current, $server->discoveryHeaders($path));
            foreach ($merged as $name => $value) {
                $response->headers->set($name, $value);
            }
        }
        return $response;
    }

    private function server(): ?BundleServer
    {
        if (!config('ispeakllm.enabled', true)) {
            return null;
        }
        $path = (string) config('ispeakllm.bundle', base_path('.ispeakllm/bundle.json'));
        if (self::$loadedFrom !== $path) {
            self::$loadedFrom = $path;
            try {
                self::$server = BundleServer::fromFile($path, (string) config('ispeakllm.cache_control', 'public, max-age=300'));
            } catch (\Throwable $e) {
                self::$server = null; // No bundle yet: the app answers everything itself.
            }
        }
        return self::$server;
    }
}
