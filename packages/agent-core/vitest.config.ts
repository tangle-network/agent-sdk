import { defineConfig } from "vitest/config";

// The SSE retained-memory test measures live heap after a full collection.
export default defineConfig({ test: { execArgv: ["--expose-gc"] } });
