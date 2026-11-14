<?php
// New for the IspeakLLM OSS port (harness style after integrations/wordpress/tests/LlmsTxtTest.php, goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
//
// `php -S` router for the conformance test: the IspeakLLM BundleServer in front of the
// reference host app from conformance/adapter-http/cases.json (`host`).

declare(strict_types=1);

require __DIR__ . '/../core/BundleServer.php';

use IspeakLLM\Core\BundleServer;

$server = BundleServer::fromFile((string) getenv('ISPEAKLLM_BUNDLE'));

$path = rawurldecode((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));
$headers = [];
foreach ($_SERVER as $k => $v) {
    if (str_starts_with($k, 'HTTP_')) {
        $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
    }
}
$req = ['method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'), 'path' => $path, 'headers' => $headers];

$res = $server->handle($req);
if ($res === null) {
    // Reference host app.
    $missing = str_starts_with($path, '/no-such-page');
    $host = [
        'status' => $missing ? 404 : 200,
        'headers' => ['content-type' => 'text/html; charset=utf-8'],
        'body' => $missing ? '<html>missing</html>' : '<html>host</html>',
    ];
    $res = $server->decorate($path, $host);
}

http_response_code($res['status']);
foreach ($res['headers'] as $name => $value) {
    header($name . ': ' . $value);
}
if ($req['method'] !== 'HEAD' && $res['status'] !== 304) {
    echo $res['body'];
}
return true;
