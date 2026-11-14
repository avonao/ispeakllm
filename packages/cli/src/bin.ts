#!/usr/bin/env node
import { run } from "./index";

run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
}).then((code) => process.exit(code));
