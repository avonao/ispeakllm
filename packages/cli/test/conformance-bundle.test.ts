// Builds the adapter conformance fixture from examples/basic-site with a fixed clock and compares it
// to conformance/adapter-http/bundle.json. UPDATE_GOLDEN=1 rewrites the fixture.
import { it, expect } from "vitest";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/index";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const golden = join(root, "conformance/adapter-http/bundle.json");

it("adapter conformance bundle is reproducible from examples/basic-site", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ispeakllm-conf-"));
  await cp(join(root, "examples/basic-site"), dir, { recursive: true });
  const code = await run(["generate"], { cwd: dir, out: () => {}, err: () => {}, now: () => new Date("2026-11-14T00:00:00Z") });
  expect(code).toBe(0);
  const built = JSON.stringify(JSON.parse(await readFile(join(dir, ".ispeakllm/bundle.json"), "utf8")), null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN || !existsSync(golden)) await writeFile(golden, built);
  expect(built).toBe(await readFile(golden, "utf8"));
});
