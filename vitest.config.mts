import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const p = (n: string) => fileURLToPath(new URL(`./packages/${n}/src/index.ts`, import.meta.url));
export default defineConfig({
  resolve: { alias: { "@ispeakllm/core": p("core"), "@ispeakllm/sign": p("sign"), "@ispeakllm/policy": p("policy"), "@ispeakllm/agents": p("agents"), "@ispeakllm/html-md": p("html-md"), "@ispeakllm/lint": p("lint"), "@ispeakllm/mcp": p("mcp"), "@ispeakllm/serve": p("serve"), "@ispeakllm/cli": p("cli"), "@ispeakllm/express": fileURLToPath(new URL("./adapters/express/src/index.ts", import.meta.url)) } },
  test: { include: ["packages/*/test/**/*.test.ts", "adapters/*/test/**/*.test.ts", "integrations/{shopify,vue,svelte,angular}/test/**/*.test.ts"], passWithNoTests: true },
});
