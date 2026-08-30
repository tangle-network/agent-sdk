import {
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  preparePackedTestCohort,
  root,
} from "./packed-test-cohort.mjs";

/**
 * Build and install the exact Interface and CLI Bridge provider archives into
 * one isolated consumer. The copied test starts the real Bridge server from
 * CLI_BRIDGE_INTEGRATION_ROOT and imports only the installed provider archive.
 */
export function prepareCliBridgeCohort() {
  const cohort = preparePackedTestCohort({
    consumerName: "agent-cli-bridge-evidence",
    temporaryPrefix: "agent-cli-bridge-evidence-",
    packages: [
      {
        key: "interface",
        name: "@tangle-network/agent-interface",
        directory: "agent-interface",
      },
      {
        key: "provider",
        name: "@tangle-network/agent-provider-cli-bridge",
        directory: "agent-provider-cli-bridge",
      },
    ],
  });
  const { consumer } = cohort;
  copyFileSync(
    join(
      root,
      "packages",
      "agent-provider-cli-bridge",
      "tests",
      "cli-bridge.integration.test.ts",
    ),
    join(consumer, "cli-bridge.integration.test.ts"),
  );
  writeFileSync(
    join(consumer, "vitest.config.mjs"),
    "export default { test: { environment: 'node' } };\n",
  );

  return cohort;
}
