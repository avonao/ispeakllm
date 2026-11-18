# iSpeakLLM for Drupal

A Drupal 10/11 module that serves your iSpeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files and per-path policy headers. HTML pages only gain `Vary: Accept`, `Link` and policy headers.

No runtime dependency beyond Drupal core. Licence: MIT.

Ported from the dormant GoPlainly Drupal module; the hosted-API proxy controller was replaced by an HTTP middleware serving the local bundle.

## Install

Copy this folder to `modules/contrib/ispeakllm` (or `composer require ispeakllm/drupal`), then `drush en ispeakllm`.

## Configure (settings.php)

```php
$settings['ispeakllm_bundle'] = '/srv/site/.ispeakllm/bundle.json'; // default: <project root>/.ispeakllm/bundle.json (the folder above the web root)
$settings['ispeakllm_cache_control'] = 'public, max-age=300';
$settings['ispeakllm_enabled'] = TRUE;
```

With no readable bundle the module passes everything through.

## How it is mounted

`ispeakllm.services.yml` registers `Drupal\ispeakllm\StackMiddleware\IspeakLLMMiddleware` as an `http_middleware` at priority 210, above the page cache, so agent variants never hit Drupal routing and cached HTML pages are decorated too. Drupal's own `robots.txt` file is shadowed when the bundle has `/robots.txt` (only if the web server passes the request to Drupal).

## Test

```sh
php integrations/drupal/tests/conformance.php
```

Boots `php -S` on a free 127.0.0.1 port with the framework-independent core (`core/BundleServer.php`, identical to the WordPress and Laravel copies, which the test checks) in front of the reference host and runs `conformance/adapter-http/runner.mjs --level core`. The Drupal middleware glue needs a Drupal site and is not exercised by this test.
