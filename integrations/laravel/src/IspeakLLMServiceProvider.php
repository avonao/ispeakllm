<?php
// New for the iSpeakLLM OSS port (no service provider in goplainly-v6-2026-11-10-current-dormant/integrations/laravel)
// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace IspeakLLM\Laravel;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Support\ServiceProvider;
use IspeakLLM\Laravel\Http\Middleware\ServeIspeakLLM;

final class IspeakLLMServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/ispeakllm.php', 'ispeakllm');
    }

    public function boot(): void
    {
        $this->publishes([__DIR__ . '/../config/ispeakllm.php' => config_path('ispeakllm.php')], 'ispeakllm-config');

        // Global middleware: `/x.md` and `/llms.txt` have no route, so route middleware would never see them.
        if (config('ispeakllm.auto_register', true) && $this->app->bound(Kernel::class)) {
            $kernel = $this->app->make(Kernel::class);
            if (method_exists($kernel, 'pushMiddleware')) {
                $kernel->pushMiddleware(ServeIspeakLLM::class);
            }
        }
    }
}
