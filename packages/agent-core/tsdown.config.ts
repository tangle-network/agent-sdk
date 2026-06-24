import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/transport/index.ts",
    "src/events/index.ts",
    "src/types/index.ts",
    "src/sse/index.ts",
    "src/auth/index.ts",
    "src/auth/browser.ts",
    "src/resilience/index.ts",
    "src/computer-use/index.ts",
  ],
  format: ["esm"],
  dts: { eager: true },
  clean: true,
  fixedExtension: false,
});
