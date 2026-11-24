import { configDefaults, defineConfig } from "vitest/config";

// `pnpm test` runs every test that needs nothing beyond this checkout, the loopback
// integration tests under `tests/` included. Each file below needs what its variable
// names. Without it the file would only skip, or pass without asserting anything, so it
// is left out by name until the variable is set.
const requires: Record<string, string> = {
  // Starts the real Bridge server from a built cli-bridge checkout.
  "tests/cli-bridge.integration.test.ts": "CLI_BRIDGE_INTEGRATION_ROOT",
  "tests/provider-evidence.integration.test.ts": "CLI_BRIDGE_INTEGRATION_ROOT",
  "tests/retained-replacement.integration.test.ts": "CLI_BRIDGE_INTEGRATION_ROOT",
  // Boots the sandbox box image on a Docker daemon.
  "tests/sandbox-checkpoint-live.integration.test.ts": "CLI_BRIDGE_BOX_IMAGE",
  // Boots the same image and runs live model turns, which also need TANGLE_API_KEY.
  "tests/sandbox-live.integration.test.ts": "CLI_BRIDGE_BOX_IMAGE",
};

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...Object.entries(requires)
        .filter(([, variable]) => !process.env[variable]?.trim())
        .map(([file]) => file),
    ],
  },
});
