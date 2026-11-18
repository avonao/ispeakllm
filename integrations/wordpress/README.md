# iSpeakLLM for WordPress

A WordPress plugin that serves your iSpeakLLM bundle (`ispeakllm generate` writes `.ispeakllm/bundle.json`) with the same HTTP behaviour as the JS adapters: `llms.txt`, `llms-full.txt`, page Markdown (`/x.md` and `Accept: text/markdown`), conditional `304`, the AI Conformance Manifest, policy files (`robots.txt`, `ai.txt`, `license.xml`, `.well-known/tdmrep.json`, `.well-known/jwks.json`) and per-path policy headers. Human HTML is never changed beyond `Vary`, `Link` and policy headers.

No Composer dependencies. Licence: MIT.

Ported from the dormant GoPlainly WordPress plugin; the hosted-API proxy was replaced by serving the local bundle.

## Install

1. Copy this folder to `wp-content/plugins/ispeakllm/` (it needs `ispeakllm.php` and `core/`).
2. Activate **iSpeakLLM** in Plugins.
3. Put the bundle where the plugin can read it.

## Configure the bundle path

First match wins:

- `define('ISPEAKLLM_BUNDLE', '/srv/site/.ispeakllm/bundle.json');` in `wp-config.php`
- the option `ispeakllm_bundle_path` (`wp option update ispeakllm_bundle_path /path/bundle.json`)
- default: `ABSPATH . '.ispeakllm/bundle.json'`

The filter `ispeakllm_bundle_path` can change the final value. With no readable bundle the plugin does nothing.

## How it is mounted

- `init` (priority 0): agent requests (`.md`, `llms.txt`, ACM, policy files, `Accept: text/markdown`) are answered from the bundle and the request ends. Admin and REST requests are skipped.
- `wp_headers`: human pages get `Vary: Accept`, `Link: </x.md>; rel="alternate"...` when the page's Markdown exists, and the policy headers.

WordPress serves a virtual `robots.txt`; when the bundle has `/robots.txt`, the bundle's file wins.

## Test

```sh
php integrations/wordpress/tests/conformance.php
```

Boots `php -S` on a free 127.0.0.1 port with `core/BundleServer.php` in front of the reference host and runs `conformance/adapter-http/runner.mjs --level core`. The WordPress hook glue (`ispeakllm.php`) is not exercised by this test; it needs a WordPress install.
