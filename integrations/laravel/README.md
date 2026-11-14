# IspeakLLM for Laravel

Serves your IspeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) from a Laravel app with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. Your HTML responses only gain `Vary: Accept`, `Link` and policy headers.

The only runtime requirements are Laravel itself (`illuminate/support`, `illuminate/http`). Licence: MIT.

Ported from the dormant GoPlainly Laravel package; the hosted-API proxy was replaced by serving the local bundle.

## Install

```sh
composer require ispeakllm/laravel
php artisan vendor:publish --tag=ispeakllm-config   # optional
```

Package discovery registers `IspeakLLM\Laravel\IspeakLLMServiceProvider`, which pushes `ServeIspeakLLM` onto the global middleware stack (it has to be global: `/x.md` has no route).

## Configure

`config/ispeakllm.php` (or `.env`):

| Key | Env | Default |
| --- | --- | --- |
| `bundle` | `ISPEAKLLM_BUNDLE` | `base_path('.ispeakllm/bundle.json')` |
| `enabled` | `ISPEAKLLM_ENABLED` | `true` |
| `cache_control` | `ISPEAKLLM_CACHE_CONTROL` | `public, max-age=300` |
| `auto_register` | `ISPEAKLLM_AUTO_REGISTER` | `true` |

With no readable bundle the middleware passes everything through.

## Mount it yourself

Set `ISPEAKLLM_AUTO_REGISTER=false`, then in Laravel 11+ `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->prepend(\IspeakLLM\Laravel\Http\Middleware\ServeIspeakLLM::class);
})
```

## Test

```sh
php integrations/laravel/tests/conformance.php
```

Boots `php -S` on a free 127.0.0.1 port with the framework-independent core (`core/BundleServer.php`, identical to the WordPress and Drupal copies, which the test checks) in front of the reference host and runs `conformance/adapter-http/runner.mjs --level core`. The Laravel glue (`src/`) needs a Laravel app and is not exercised by this test.
