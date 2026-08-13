import { spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared packer for the "control cohort": the three publishable control
// contract packages (agent-interface, agent-provider-testkit,
// agent-provider-tangle) are packed to tarballs, installed into one isolated
// consumer, and the contract test files are copied in with re-export shims.
// Both check-control-contract-artifacts.mjs and upstream-check.mjs build on the
// same packed consumer so the release-evidence checks and the contract check
// share one packing path.

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const executableSuffix = process.platform === "win32" ? ".cmd" : "";

export const vitest = join(
  root,
  "packages",
  "agent-provider-testkit",
  "node_modules",
  ".bin",
  `vitest${executableSuffix}`,
);
export const tsc = join(
  root,
  "packages",
  "agent-interface",
  "node_modules",
  ".bin",
  `tsc${executableSuffix}`,
);

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

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function pack(packageDirectory, destination) {
  const output = run(
    pnpm,
    ["pack", "--json", "--pack-destination", destination],
    { cwd: packageDirectory },
  );
  const result = JSON.parse(output);
  if (!result.filename || !existsSync(result.filename)) {
    throw new Error(`failed to pack ${packageDirectory}`);
  }
  return result.filename;
}

function tarballName(tarball) {
  const filename = tarball.split(/[\\/]/).at(-1);
  return filename ?? tarball;
}

// Build the three control packages, pack them, install the tarballs into one
// isolated consumer, and copy every contract test file plus its re-export
// shims. The caller runs tsc and/or vitest against the returned consumer and
// then calls cleanup().
export function prepareControlCohort() {
  run(pnpm, ["--filter", "@tangle-network/agent-interface", "build"]);
  run(pnpm, ["--filter", "@tangle-network/agent-provider-testkit", "build"]);
  run(pnpm, ["--filter", "@tangle-network/agent-provider-tangle", "build"]);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-control-artifacts-"));
  const tarballsDirectory = join(temporaryRoot, "tarballs");
  const consumer = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  mkdirSync(tarballsDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  const interfaceTarball = pack(
    join(root, "packages", "agent-interface"),
    tarballsDirectory,
  );
  const testkitTarball = pack(
    join(root, "packages", "agent-provider-testkit"),
    tarballsDirectory,
  );
  const tangleTarball = pack(
    join(root, "packages", "agent-provider-tangle"),
    tarballsDirectory,
  );

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "agent-control-artifact-check",
        private: true,
        type: "module",
        dependencies: {
          "@tangle-network/agent-interface": `file:${interfaceTarball}`,
          "@tangle-network/agent-provider-testkit": `file:${testkitTarball}`,
          "@tangle-network/agent-provider-tangle": `file:${tangleTarball}`,
          "@tangle-network/sandbox": "0.22.0",
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

  const packageVersions = [
    interfaceTarball,
    testkitTarball,
    tangleTarball,
  ].map(tarballName);

  return {
    temporaryRoot,
    consumer,
    tarballs: {
      interface: interfaceTarball,
      testkit: testkitTarball,
      tangle: tangleTarball,
    },
    packageVersions,
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}
