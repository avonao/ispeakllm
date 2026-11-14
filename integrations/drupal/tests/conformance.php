<?php
// New for the IspeakLLM OSS port (harness style after integrations/wordpress/tests/LlmsTxtTest.php, goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT
//
// Boots `php -S 127.0.0.1:<free port>` with tests/router.php (BundleServer + reference host),
// runs conformance/adapter-http/runner.mjs --level core against it, shuts it down.
// Also checks that the shared PHP core is byte-identical across the PHP integrations.
//
//   php integrations/<wordpress|laravel|drupal>/tests/conformance.php

declare(strict_types=1);

$pkg = dirname(__DIR__);
$repo = dirname($pkg, 2);
$conf = $repo . '/conformance/adapter-http';

// 1. The PHP integrations ship the same core.
$core = $pkg . '/core/BundleServer.php';
foreach (['wordpress', 'laravel', 'drupal'] as $sibling) {
    $other = $repo . '/integrations/' . $sibling . '/core/BundleServer.php';
    if (is_file($other) && hash_file('sha256', $other) !== hash_file('sha256', $core)) {
        fwrite(STDERR, "FAIL  core/BundleServer.php differs from integrations/$sibling/core/BundleServer.php\n");
        exit(1);
    }
}

// 2. Free port on 127.0.0.1.
$probe = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if (!$probe) {
    fwrite(STDERR, "cannot bind: $errstr\n");
    exit(1);
}
$port = (int) substr((string) strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
fclose($probe);

// 3. Server.
$env = array_merge(getenv(), ['ISPEAKLLM_BUNDLE' => $conf . '/bundle.json']);
$docroot = sys_get_temp_dir();
$cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot, __DIR__ . '/router.php'];
$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, $pkg, $env);
if (!is_resource($proc)) {
    fwrite(STDERR, "cannot start php -S\n");
    exit(1);
}
$up = false;
for ($i = 0; $i < 100 && !$up; $i++) {
    $s = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.1);
    if ($s) {
        fclose($s);
        $up = true;
    } else {
        usleep(50000);
    }
}

// 4. Runner.
$code = 1;
if ($up) {
    passthru('node ' . escapeshellarg($conf . '/runner.mjs') . ' ' . escapeshellarg("http://127.0.0.1:$port") . ' --level core', $code);
} else {
    fwrite(STDERR, "php -S did not come up on port $port\n");
}
proc_terminate($proc);
proc_close($proc);
exit($code);
