import {
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  pnpm,
  preparePackedTestCohort,
  root,
  run,
  tsc,
  vitest,
} from "./packed-test-cohort.mjs";

export { pnpm, root, run, tsc, vitest } from "./packed-test-cohort.mjs";

// Shared packer for the "control cohort": the three publishable control
// contract packages (agent-interface, agent-provider-testkit,
// agent-provider-tangle) are packed to tarballs, installed into one isolated
// consumer, and the contract test files are copied in with re-export shims.
// Both check-control-contract-artifacts.mjs and upstream-check.mjs build on the
// same packed consumer so the release-evidence checks and the contract check
// share one packing path.

// The interface contract test files copied into the packed consumer. Each one
// imports sibling modules through the re-export shims written below.
export const interfaceTests = [
  "environment-provider.test.ts",
  "interaction.test.ts",
  "portable-context.test.ts",
  "runtime-control.test.ts",
  "workspace-branching.test.ts",
];

// The testkit conformance file and the packed Tangle consumer fixture copied
// into the consumer next to the interface tests.
export const testkitTest = "control-conformance.test.ts";
export const tangleFixtureTest = "tangle-control-consumer.test.ts";
export const tangleLiveFixture = "tangle-live-control.mjs";

// The consumer must install the same Sandbox version the Tangle provider is
// developed against. Read it from that package so the pin cannot drift from
// the published peer range.
function sandboxVersion() {
  const manifest = JSON.parse(
    readFileSync(
      join(root, "packages", "agent-provider-tangle", "package.json"),
      "utf8",
    ),
  );
  const version = manifest.devDependencies?.["@tangle-network/sandbox"];
  if (typeof version !== "string") {
    throw new Error(
      "agent-provider-tangle must declare a @tangle-network/sandbox devDependency",
    );
  }
  return version;
}

// Build the three control packages, pack them, install the tarballs into one
// isolated consumer, and copy every contract test file plus its re-export
// shims. The caller runs tsc and/or vitest against the returned consumer and
// then calls cleanup().
export function prepareControlCohort() {
  const cohort = preparePackedTestCohort({
    consumerName: "agent-control-artifact-check",
    temporaryPrefix: "agent-control-artifacts-",
    packages: [
      {
        key: "interface",
        name: "@tangle-network/agent-interface",
        directory: "agent-interface",
      },
      {
        key: "testkit",
        name: "@tangle-network/agent-provider-testkit",
        directory: "agent-provider-testkit",
      },
      {
        key: "tangle",
        name: "@tangle-network/agent-provider-tangle",
        directory: "agent-provider-tangle",
      },
    ],
    dependencies: {
      "@tangle-network/sandbox": sandboxVersion(),
    },
  });
  const { consumer } = cohort;

  for (const test of interfaceTests) {
    copyFileSync(
      join(root, "packages", "agent-interface", "src", test),
      join(consumer, test),
    );
  }
  copyFileSync(
    join(
      root,
      "packages",
      "agent-provider-testkit",
      "src",
      "control-conformance.test.ts",
    ),
    join(consumer, testkitTest),
  );
  copyFileSync(
    join(root, "scripts", "fixtures", "tangle-control-consumer.test.ts"),
    join(consumer, tangleFixtureTest),
  );
  copyFileSync(
    join(root, "scripts", "fixtures", tangleLiveFixture),
    join(consumer, tangleLiveFixture),
  );

  const shimSources = {
    "environment-provider": "@tangle-network/agent-interface",
    "environment-runtime":
      "@tangle-network/agent-interface/environment-provider",
    interaction: "@tangle-network/agent-interface",
    "interaction-envelope": "@tangle-network/agent-interface",
    "portable-context": "@tangle-network/agent-interface",
    "runtime-control": "@tangle-network/agent-interface",
    "workspace-branching": "@tangle-network/agent-interface",
  };
  for (const [shim, source] of Object.entries(shimSources)) {
    writeFileSync(join(consumer, `${shim}.ts`), `export * from "${source}";\n`);
  }
  writeFileSync(
    join(consumer, "index.ts"),
    [
      'export * from "@tangle-network/agent-interface";',
      'export * from "@tangle-network/agent-provider-testkit";',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumer, "vitest.config.mjs"),
    "export default { test: { environment: 'node' } };\n",
  );

  return cohort;
}
