// IspeakLLM Worker template. Run `npx ispeakllm generate` first; it writes .ispeakllm/bundle.json.
import bundle from "../.ispeakllm/bundle.json";
import { createWorker } from "@ispeakllm/edge-worker";
import type { Bundle } from "@ispeakllm/serve";

export default createWorker(bundle as Bundle);
