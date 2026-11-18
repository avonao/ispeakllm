<?php
// New for the iSpeakLLM OSS port (config keys follow goplainly.llmstxt.* used by integrations/laravel/src/Http/Controllers/LlmsTxtController.php, goplainly-v6-2026-11-10-current-dormant)
// SPDX-License-Identifier: MIT

return [
    // Turn the middleware off without uninstalling the package.
    'enabled' => env('ISPEAKLLM_ENABLED', true),

    // The bundle written by `ispeakllm generate`.
    'bundle' => env('ISPEAKLLM_BUNDLE', base_path('.ispeakllm/bundle.json')),

    // Cache-Control for Markdown, llms.txt, the ACM and policy files.
    'cache_control' => env('ISPEAKLLM_CACHE_CONTROL', 'public, max-age=300'),

    // Push the middleware onto the global HTTP stack automatically. Set false to register
    // IspeakLLM\Laravel\Http\Middleware\ServeIspeakLLM yourself (bootstrap/app.php in Laravel 11+).
    'auto_register' => env('ISPEAKLLM_AUTO_REGISTER', true),
];
