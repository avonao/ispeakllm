<?php
// Ported from packages/serve/src/index.ts + packages/core/src/negotiate.ts (ispeakllm); framework wiring from integrations/*/LlmsTxtController.php (goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
//
// Framework-independent iSpeakLLM bundle server for PHP. No Composer runtime dependencies.
// The WordPress, Laravel and Drupal integrations ship identical copies of this file
// (each test checks the copies match).
//
// Request:  ['method' => 'GET', 'path' => '/docs/x.md', 'headers' => ['accept' => '...', ...]]
//           (header names lower-case; 'path' is the decoded URL path without the query)
// Response: ['status' => 200, 'headers' => ['content-type' => '...', ...], 'body' => '...']

declare(strict_types=1);

namespace IspeakLLM\Core;

final class BundleServer
{
    public const POLICY_PATHS = ['/robots.txt', '/ai.txt', '/license.xml', '/.well-known/tdmrep.json', '/.well-known/jwks.json'];
    public const ACM_PATH = '/.well-known/ai-conformance.json';
    public const ACM_TYPE = 'application/ai-conformance+json';

    /** @var array<string,mixed> */
    private array $bundle;
    private string $cacheControl;

    /** @param array<string,mixed> $bundle */
    public function __construct(array $bundle, string $cacheControl = 'public, max-age=300')
    {
        if (($bundle['version'] ?? null) !== 1 || !is_array($bundle['files'] ?? null)) {
            throw new \InvalidArgumentException('iSpeakLLM: not a version 1 bundle');
        }
        $this->bundle = $bundle;
        $this->cacheControl = $cacheControl;
    }

    public static function fromFile(string $path, string $cacheControl = 'public, max-age=300'): self
    {
        $raw = @file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('iSpeakLLM: cannot read bundle at ' . $path);
        }
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        return new self($data, $cacheControl);
    }

    /** @return array<string,mixed>|null */
    private function file(string $path): ?array
    {
        $f = $this->bundle['files'][$path] ?? null;
        return is_array($f) ? $f : null;
    }

    /**
     * Answer the request from the bundle, or return null to let the host app answer.
     *
     * @param array{method?:string,path:string,headers?:array<string,string>} $req
     * @return array{status:int,headers:array<string,string>,body:string}|null
     */
    public function handle(array $req): ?array
    {
        $method = strtoupper($req['method'] ?? 'GET');
        if ($method !== 'GET' && $method !== 'HEAD') {
            return null;
        }
        $path = $req['path'];
        $headers = self::lowerKeys($req['headers'] ?? []);
        $head = $method === 'HEAD';

        if (in_array($path, self::POLICY_PATHS, true) && ($f = $this->file($path))) {
            return self::res(200, ['content-type' => (string) $f['type'], 'cache-control' => $this->cacheControl], $head ? '' : (string) $f['body']);
        }

        $v = self::negotiate($path, $headers['accept'] ?? null);
        if ($v['variant'] === 'acm') {
            $f = $this->file(self::ACM_PATH);
            if (!$f) {
                return null;
            }
            return self::res(200, ['content-type' => self::ACM_TYPE, 'cache-control' => $this->cacheControl, 'vary' => 'Accept'], $head ? '' : (string) $f['body']);
        }
        if ($v['variant'] === 'llmstxt' || $v['variant'] === 'llmsfull') {
            $f = $this->file($v['variant'] === 'llmstxt' ? '/llms.txt' : '/llms-full.txt');
            return $f ? $this->markdown($f, $headers, $head, '/') : null;
        }
        if ($v['variant'] === 'md') {
            $pagePath = ($v['pagePath'] ?? '/') !== '' ? $v['pagePath'] : '/';
            $f = $this->file($pagePath === '/' ? '/index.md' : $pagePath . '.md');
            if ($f) {
                return $this->markdown($f, $headers, $head, $pagePath);
            }
            if (str_ends_with($path, '.md')) {
                return self::res(404, ['content-type' => 'text/plain; charset=utf-8', 'vary' => 'Accept'], $head ? '' : "No Markdown is published for this page.\n");
            }
            return null; // Accept: text/markdown on a page we don't know: the host answers with HTML.
        }
        return null;
    }

    /**
     * Headers to add to a human HTML page: Link to its Markdown (when published), Vary: Accept, policy headers.
     *
     * @return array<string,string>
     */
    public function discoveryHeaders(string $pathname): array
    {
        $h = ['vary' => 'Accept'];
        $md = $pathname === '/' ? '/index.md' : rtrim($pathname, '/') . '.md';
        if ($this->file($md)) {
            $h['link'] = self::linkHeaderValue($pathname, isset($this->bundle['origin']) ? (string) $this->bundle['origin'] : null);
        }
        foreach ($this->pathHeadersFor($pathname) as $k => $val) {
            if ($val !== '') {
                $h[strtolower((string) $k)] = (string) $val;
            }
        }
        return $h;
    }

    /**
     * Decorate the host app's response. Only HTML responses change; the body is untouched.
     * Existing Vary values are kept (Accept appended), an existing Link is extended.
     *
     * @param array{status:int,headers:array<string,string>,body?:string} $res
     * @return array{status:int,headers:array<string,string>,body?:string}
     */
    public function decorate(string $pathname, array $res): array
    {
        $headers = self::lowerKeys($res['headers']);
        if (!str_contains($headers['content-type'] ?? '', 'text/html')) {
            return $res;
        }
        $res['headers'] = self::mergeDiscovery($headers, $this->discoveryHeaders($pathname));
        return $res;
    }

    /**
     * Merge discovery headers into an existing lower-case header map.
     *
     * @param array<string,string> $headers
     * @param array<string,string> $add
     * @return array<string,string>
     */
    public static function mergeDiscovery(array $headers, array $add): array
    {
        foreach ($add as $k => $v) {
            if ($k === 'vary') {
                $cur = $headers['vary'] ?? '';
                if ($cur === '' || !preg_match('/(^|,)\s*(accept|\*)\s*(,|$)/i', $cur)) {
                    $headers['vary'] = $cur !== '' ? $cur . ', Accept' : 'Accept';
                }
            } elseif ($k === 'link') {
                $headers['link'] = isset($headers['link']) && $headers['link'] !== '' ? $headers['link'] . ', ' . $v : $v;
            } else {
                $headers[$k] = $v;
            }
        }
        return $headers;
    }

    /** Longest key of bundle.pathHeaders that prefixes the path ("/" is the default). @return array<string,string> */
    public function pathHeadersFor(string $pathname): array
    {
        $ph = $this->bundle['pathHeaders'] ?? null;
        if (!is_array($ph)) {
            return [];
        }
        $best = '/';
        foreach (array_keys($ph) as $k) {
            $k = (string) $k;
            if (str_starts_with($pathname, $k) && strlen($k) > strlen($best)) {
                $best = $k;
            }
        }
        return is_array($ph[$best] ?? null) ? $ph[$best] : [];
    }

    /**
     * @param array<string,mixed> $f
     * @param array<string,string> $reqHeaders
     * @return array{status:int,headers:array<string,string>,body:string}
     */
    private function markdown(array $f, array $reqHeaders, bool $head, string $policyPath): array
    {
        $body = (string) $f['body'];
        $etag = isset($f['etag']) ? (string) $f['etag'] : '"' . substr(hash('sha256', $body), 0, 32) . '"';
        $tokens = isset($f['tokens']) ? (int) $f['tokens'] : ($body === '' ? 0 : (int) ceil(strlen($body) / 4));
        $h = [
            'content-type' => isset($f['type']) ? (string) $f['type'] : 'text/markdown; charset=utf-8',
            'vary' => 'Accept',
            'x-markdown-tokens' => (string) $tokens,
            'etag' => $etag,
            'cache-control' => $this->cacheControl,
        ];
        foreach ($this->pathHeadersFor($policyPath) as $k => $val) {
            if ($val !== '') {
                $h[strtolower((string) $k)] = (string) $val;
            }
        }
        if (isset($reqHeaders['if-none-match'])) {
            $tags = array_map([self::class, 'stripWeak'], explode(',', $reqHeaders['if-none-match']));
            if (in_array('*', $tags, true) || in_array(self::stripWeak($etag), $tags, true)) {
                return self::res(304, $h, '');
            }
        }
        return self::res(200, $h, $head ? '' : $body);
    }

    private static function stripWeak(string $t): string
    {
        return (string) preg_replace('/^W\//', '', trim($t));
    }

    public static function linkHeaderValue(string $pathname, ?string $origin = null): string
    {
        $abs = static fn (string $p): string => $origin ? rtrim($origin, '/') . $p : $p;
        $p = strlen($pathname) > 1 ? rtrim($pathname, '/') : $pathname;
        $md = ($p === '/' || $p === '') ? '/index.md' : $p . '.md';
        return '<' . $abs($md) . '>; rel="alternate"; type="text/markdown", <' . $abs('/llms.txt') . '>; rel="describedby"; type="text/markdown"';
    }

    /**
     * Port of @ispeakllm/core negotiate() (without locales).
     *
     * @return array{variant:string,pagePath?:string}
     */
    public static function negotiate(string $path, ?string $accept): array
    {
        if ($path === self::ACM_PATH) {
            return ['variant' => 'acm'];
        }
        if ($path === '/llms.txt') {
            return ['variant' => 'llmstxt'];
        }
        if ($path === '/llms-full.txt') {
            return ['variant' => 'llmsfull'];
        }
        if (str_ends_with($path, '.md')) {
            $pagePath = substr($path, 0, -3);
            if ($pagePath === '' || $pagePath === '/index') {
                $pagePath = '/';
            } elseif (str_ends_with($pagePath, '/index')) {
                $pagePath = substr($pagePath, 0, -6);
                if ($pagePath === '') {
                    $pagePath = '/';
                }
            }
            return ['variant' => 'md', 'pagePath' => $pagePath];
        }

        $entries = self::parseAccept($accept);
        $find = static function (string $type) use ($entries): ?array {
            foreach ($entries as $e) {
                if ($e['type'] === $type) {
                    return $e;
                }
            }
            return null;
        };
        $acm = $find(self::ACM_TYPE);
        $md = $find('text/markdown');
        $html = $find('text/html') ?? $find('text/*') ?? $find('*/*');
        $cands = [];
        if ($acm && $acm['q'] > 0) {
            $cands[] = ['variant' => 'acm', 'q' => $acm['q'], 'rank' => 0, 'index' => $acm['index']];
        }
        if ($md && $md['q'] > 0) {
            $cands[] = ['variant' => 'md', 'q' => $md['q'], 'rank' => 1, 'index' => $md['index']];
        }
        if ($html && $html['q'] > 0) {
            $cands[] = ['variant' => 'html', 'q' => $html['q'], 'rank' => 1, 'index' => $html['index']];
        }
        usort($cands, static fn (array $a, array $b): int => ($b['q'] <=> $a['q']) ?: ($a['rank'] <=> $b['rank']) ?: ($a['index'] <=> $b['index']));
        $best = $cands[0] ?? null;
        if ($best && $best['variant'] === 'acm') {
            return ['variant' => 'acm'];
        }
        if ($best && $best['variant'] === 'md') {
            $pagePath = (str_ends_with($path, '/') && $path !== '/') ? substr($path, 0, -1) : $path;
            return ['variant' => 'md', 'pagePath' => $pagePath];
        }
        return ['variant' => 'html'];
    }

    /** @return list<array{type:string,q:float,index:int}> */
    public static function parseAccept(?string $header): array
    {
        if ($header === null || $header === '') {
            return [];
        }
        $out = [];
        foreach (explode(',', $header) as $index => $part) {
            $params = explode(';', $part);
            $type = strtolower(trim((string) array_shift($params)));
            if ($type === '') {
                continue;
            }
            $q = 1.0;
            foreach ($params as $p) {
                if (preg_match('/^\s*q\s*=\s*([0-9.]+)\s*$/i', $p, $m)) {
                    $q = is_numeric($m[1]) ? min(1.0, max(0.0, (float) $m[1])) : 0.0;
                }
            }
            $out[] = ['type' => $type, 'q' => $q, 'index' => $index];
        }
        return $out;
    }

    /** @param array<string,string|string[]> $h @return array<string,string> */
    public static function lowerKeys(array $h): array
    {
        $out = [];
        foreach ($h as $k => $v) {
            $out[strtolower((string) $k)] = is_array($v) ? implode(', ', $v) : (string) $v;
        }
        return $out;
    }

    /** @param array<string,string> $headers @return array{status:int,headers:array<string,string>,body:string} */
    private static function res(int $status, array $headers, string $body): array
    {
        return ['status' => $status, 'headers' => $headers, 'body' => $body];
    }
}
