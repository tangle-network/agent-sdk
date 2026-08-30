import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  npm,
  pack,
  pnpm,
  root,
  run,
  tarballName,
} from "./control-cohort.mjs";

/**
 * Build and install the exact Interface and CLI Bridge provider archives into
 * one isolated consumer. The copied test starts the real Bridge server from
 * CLI_BRIDGE_INTEGRATION_ROOT and imports only the installed provider archive.
 */
export function prepareCliBridgeCohort() {
  run(pnpm, ["--filter", "@tangle-network/agent-interface", "build"]);
  run(pnpm, ["--filter", "@tangle-network/agent-provider-cli-bridge", "build"]);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-cli-bridge-evidence-"));
  const tarballsDirectory = join(temporaryRoot, "tarballs");
  const consumer = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  mkdirSync(tarballsDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  const interfaceTarball = pack(
    join(root, "packages", "agent-interface"),
    tarballsDirectory,
  );
  const providerTarball = pack(
    join(root, "packages", "agent-provider-cli-bridge"),
    tarballsDirectory,
  );
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "agent-cli-bridge-evidence",
        private: true,
        type: "module",
        dependencies: {
          "@tangle-network/agent-interface": `file:${interfaceTarball}`,
          "@tangle-network/agent-provider-cli-bridge": `file:${providerTarball}`,
          "@types/node": "25.6.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  run(npm, ["install", "--package-lock=false", "--ignore-scripts"], {
    cwd: consumer,
    env: {
      npm_config_audit: "false",
      npm_config_cache: npmCache,
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  symlinkSync(
    join(root, "packages", "agent-provider-testkit", "node_modules", "vitest"),
    join(consumer, "node_modules", "vitest"),
    "dir",
  );
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

  return {
    temporaryRoot,
    consumer,
    packageVersions: [interfaceTarball, providerTarball].map(tarballName),
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (existsSync(temporaryRoot)) {
        throw new Error("CLI Bridge cohort cleanup left its temporary root");
      }
    },
  };
}
