import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathFromFile, type SourceFile } from "../src/index";

export const FIXTURE = fileURLToPath(new URL("../../../conformance/core-site/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Load `conformance/core-site/content/<sub>` as SourceFiles (sorted, so the order is stable). */
export function loadFixture(sub = ""): SourceFile[] {
  const root = join(FIXTURE, "content", sub);
  return walk(root)
    .filter((p) => sub !== "" || !relative(root, p).startsWith("de/"))
    .sort()
    .map((p) => ({ path: pathFromFile(relative(root, p)), raw: readFileSync(p, "utf8") }));
}

/** Compare against a golden file; set UPDATE_GOLDEN=1 to (re)write it. */
export function golden(name: string, actual: string): string | null {
  const p = join(FIXTURE, "golden", name);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, actual);
    return actual;
  }
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
