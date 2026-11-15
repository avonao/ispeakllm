#!/usr/bin/env node
/**
 * One-command release of IspeakLLM 0.1.0 (founder, 15 Nov, FN-IS-1/FN-IS-2: keep the names; publish at the Part B
 * launch to npm and the other registries, and make this repo public at the same time).
 *
 *   node scripts/release.mjs          # dry run: builds every npm package into .release/, packs it, checks the other
 *                                     # registries' manifests and tools, lists which credentials are present
 *   node scripts/release.mjs --go     # publishes everything whose credential is present, then makes the repo public
 *
 * Credentials come from ~/.claude/deploy-slots/ispeakllm-npm.env (outside every repo, never printed):
 *   NPM_TOKEN (npm, @ispeakllm scope)   PYPI_TOKEN (PyPI)   GEM_HOST_API_KEY (RubyGems)   NUGET_API_KEY (NuGet)
 * Go needs no credential (a tag on the public repo). Packagist, Maven Central and WordPress.org need one-time
 * account steps; the script prints them. A registry without its credential is skipped and listed, never guessed.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO = process.argv.includes("--go");
const OUT = join(root, ".release");
const VERSION = "0.1.0";
const creds = (() => {
  const f = join(homedir(), ".claude/deploy-slots/ispeakllm-npm.env");
  if (!existsSync(f)) return {};
  return Object.fromEntries(readFileSync(f, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
})();
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || "").slice(-500)}`);
  return r.stdout;
};
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const report = [];

// npm: dependency order (a package is published after the @ispeakllm packages it imports)
const NPM_DIRS = ["packages/core", "packages/sign", "packages/policy", "packages/html-md", "packages/agents", "packages/lint", "packages/mcp", "packages/serve", "packages/cli", "adapters/edge-worker", "adapters/express", "adapters/hono", "adapters/next", "integrations/shopify", "integrations/vue", "integrations/svelte", "integrations/angular"];

function addJsExtensions(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) addJsExtensions(p);
    else if (p.endsWith(".d.ts")) {
      const src = readFileSync(p, "utf8").replace(/(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre, q, spec) => {
        if (/\.(js|mjs|cjs|json)$/.test(spec)) return m;
        const isDir = existsSync(join(dirname(p), spec)) && statSync(join(dirname(p), spec)).isDirectory();
        return `${pre}${q}${spec}${isDir ? "/index.js" : ".js"}${q}`;
      });
      writeFileSync(p, src);
    }
  }
}

async function buildNpm() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "npm"), { recursive: true });
  // Declarations for every package in one tsc run (paths resolve the sibling packages from source).
  const tsconfig = join(OUT, "tsconfig.types.json");
  writeFileSync(tsconfig, JSON.stringify({ extends: "../tsconfig.json", compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: "./types", rootDir: ".." }, include: NPM_DIRS.map((d) => `../${d}/src`), exclude: ["../**/*.test.ts"] }));
  run(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig]);
  const tarballs = [];
  for (const dir of NPM_DIRS) {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const stage = join(OUT, "npm", pkg.name.replace("/", "__"));
    mkdirSync(join(stage, "dist"), { recursive: true });
    const externals = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), "@ispeakllm/*"];
    await build({ entryPoints: [join(root, dir, "src/index.ts")], bundle: true, format: "esm", platform: "neutral", target: "es2022", outfile: join(stage, "dist/index.js"), external: [...externals, "node:*"], logLevel: "error", mainFields: ["module", "main"] });
    cpSync(join(OUT, "types", dir, "src"), join(stage, "dist"), { recursive: true });
    addJsExtensions(join(stage, "dist"));
    if (pkg.bin) {
      run("npm", ["run", "build", "-w", pkg.name]);
      cpSync(join(root, dir, "dist"), join(stage, "dist"), { recursive: true });
    }
    for (const f of ["README.md", "LICENSE"]) {
      const from = existsSync(join(root, dir, f)) ? join(root, dir, f) : join(root, f);
      if (existsSync(from)) cpSync(from, join(stage, f));
    }
    const { private: _p, main: _m, types: _t, scripts: _s, devDependencies: _d, ...rest } = pkg;
    const out = {
      ...rest,
      version: VERSION,
      license: pkg.license ?? "MIT",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist", "README.md", "LICENSE"],
      repository: { type: "git", url: "git+https://github.com/avonao/ispeakllm.git", directory: dir },
      publishConfig: { access: "public" },
    };
    writeFileSync(join(stage, "package.json"), JSON.stringify(out, null, 2) + "\n");
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", join(OUT, "npm")], { cwd: stage }));
    tarballs.push({ name: pkg.name, stage, file: packed[0].filename, files: packed[0].files.length });
  }
  return tarballs;
}

async function main() {
  console.log(`IspeakLLM ${VERSION} release (${GO ? "GO" : "dry run"})`);
  const npm = await buildNpm();
  for (const t of npm) console.log(`npm  ${t.name}: built and packed (${t.files} files)`);
  if (GO && creds.NPM_TOKEN) {
    for (const t of npm) {
      writeFileSync(join(t.stage, ".npmrc"), "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
      run("npm", ["publish", "--access", "public"], { cwd: t.stage, env: { ...process.env, NPM_TOKEN: creds.NPM_TOKEN } });
      report.push(`npm ${t.name}: unpublished -> ${VERSION}`);
    }
  } else report.push(`npm (${npm.length} packages): ${creds.NPM_TOKEN ? "ready" : "waits for NPM_TOKEN"}`);

  // PyPI: integrations/python (ispeakllm-wsgi)
  const py = join(root, "integrations/python");
  if (has("python3") && spawnSync("python3", ["-c", "import build, twine"]).status === 0) {
    run("python3", ["-m", "build", "--outdir", join(OUT, "pypi")], { cwd: py });
    if (GO && creds.PYPI_TOKEN) {
      run("python3", ["-m", "twine", "upload", join(OUT, "pypi", "*")], { env: { ...process.env, TWINE_USERNAME: "__token__", TWINE_PASSWORD: creds.PYPI_TOKEN }, shell: true });
      report.push(`PyPI ispeakllm-wsgi: unpublished -> ${VERSION}`);
    } else report.push(`PyPI ispeakllm-wsgi: built; ${creds.PYPI_TOKEN ? "ready" : "waits for PYPI_TOKEN"}`);
  } else report.push("PyPI ispeakllm-wsgi: needs `python3 -m pip install build twine` on the release machine, then PYPI_TOKEN");

  // RubyGems: integrations/rack (ispeakllm-rack)
  const rb = join(root, "integrations/rack");
  if (has("gem")) {
    run("gem", ["build", "ispeakllm-rack.gemspec", "--output", join(OUT, `ispeakllm-rack-${VERSION}.gem`)], { cwd: rb });
    if (GO && creds.GEM_HOST_API_KEY) {
      run("gem", ["push", join(OUT, `ispeakllm-rack-${VERSION}.gem`)], { env: { ...process.env, GEM_HOST_API_KEY: creds.GEM_HOST_API_KEY } });
      report.push(`RubyGems ispeakllm-rack: unpublished -> ${VERSION}`);
    } else report.push(`RubyGems ispeakllm-rack: built; ${creds.GEM_HOST_API_KEY ? "ready" : "waits for GEM_HOST_API_KEY"}`);
  } else report.push("RubyGems ispeakllm-rack: needs `gem` on the release machine");

  // NuGet: integrations/aspnetcore (IspeakLLM.AspNetCore)
  if (has("dotnet")) {
    run("dotnet", ["pack", "integrations/aspnetcore/src", "-c", "Release", "-o", join(OUT, "nuget")]);
    if (GO && creds.NUGET_API_KEY) {
      run("dotnet", ["nuget", "push", join(OUT, "nuget", "*.nupkg"), "--api-key", creds.NUGET_API_KEY, "--source", "https://api.nuget.org/v3/index.json"], { shell: true });
      report.push(`NuGet IspeakLLM.AspNetCore: unpublished -> ${VERSION}`);
    } else report.push(`NuGet IspeakLLM.AspNetCore: packed; ${creds.NUGET_API_KEY ? "ready" : "waits for NUGET_API_KEY"}`);
  } else report.push("NuGet IspeakLLM.AspNetCore: needs the .NET SDK on the release machine, then NUGET_API_KEY");

  // Maven Central, Packagist, WordPress.org: one-time account steps (printed), then their own upload
  report.push("Maven Central io.github.avonao:ispeakllm-spring: needs a Central Portal account with the io.github.avonao namespace and a GPG key; then the pom gets the central-publishing and gpg plugins and `mvn -f integrations/spring/pom.xml deploy` runs");
  report.push("Packagist ispeakllm/laravel, ispeakllm/drupal: Packagist reads composer.json at a repository root; needs read-only split repos (avonao/ispeakllm-laravel, avonao/ispeakllm-drupal) after the repo is public, then submit them at https://packagist.org/packages/submit");
  report.push("WordPress.org plugin: submit the zip of integrations/wordpress at https://wordpress.org/plugins/developers/add/ (manual review)");

  // Go: tag on the public repo (module github.com/avonao/ispeakllm/integrations/go)
  // Repo public at the same time (FN-IS-2c)
  if (GO) {
    run("git", ["tag", `integrations/go/v${VERSION}`]);
    run("git", ["push", "origin", `integrations/go/v${VERSION}`]);
    report.push(`Go module integrations/go: untagged -> v${VERSION}`);
    run("gh", ["repo", "edit", "avonao/ispeakllm", "--visibility", "public", "--accept-visibility-change-consequences"]);
    report.push("avonao/ispeakllm visibility: private -> public");
  } else report.push(`Go module integrations/go: tag integrations/go/v${VERSION} at --go; repo avonao/ispeakllm: private -> public at --go`);

  console.log(`\n${GO ? "setting: old -> new" : "plan"}`);
  for (const r of report) console.log(`- ${r}`);
  console.log(`\nartifacts in ${relative(process.cwd(), OUT) || OUT}`);
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  for (const r of report) console.error(`- ${r}`);
  process.exit(1);
});
