import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const executableSuffix = process.platform === "win32" ? ".cmd" : "";

function catalogVersion(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").match(
    new RegExp(`^  ["']${escapedName}["']:\\s+([^\\s#]+)\\s*$`, "mu"),
  );
  if (!match) throw new Error(`pnpm catalog has no version for ${name}`);
  return match[1];
}

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

/**
 * Build publishable packages and install their archives into one clean test
 * consumer. The caller copies only the fixtures required for its proof.
 */
export function preparePackedTestCohort(options) {
  const packageKeys = new Set();
  const packageNames = new Set();
  for (const entry of options.packages) {
    if (packageKeys.has(entry.key)) {
      throw new Error(`duplicate packed cohort package key: ${entry.key}`);
    }
    if (packageNames.has(entry.name)) {
      throw new Error(`duplicate packed cohort package name: ${entry.name}`);
    }
    packageKeys.add(entry.key);
    packageNames.add(entry.name);
  }
  for (const entry of options.packages) {
    run(pnpm, ["--filter", entry.name, "build"]);
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), options.temporaryPrefix));
  const tarballsDirectory = join(temporaryRoot, "tarballs");
  const consumer = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  mkdirSync(tarballsDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  const tarballs = Object.fromEntries(
    options.packages.map((entry) => [
      entry.key,
      pack(join(root, "packages", entry.directory), tarballsDirectory),
    ]),
  );
  const packedDependencies = Object.fromEntries(
    options.packages.map((entry) => [
      entry.name,
      `file:${tarballs[entry.key]}`,
    ]),
  );

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: options.consumerName,
        private: true,
        type: "module",
        dependencies: {
          "@types/node": catalogVersion("@types/node"),
          ...options.dependencies,
          ...packedDependencies,
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
  const vitestSource = options.packages
    .map((entry) =>
      join(root, "packages", entry.directory, "node_modules", "vitest"),
    )
    .find((path) => existsSync(path));
  if (!vitestSource) {
    throw new Error("packed cohort requires Vitest in one package workspace");
  }
  symlinkSync(
    vitestSource,
    join(consumer, "node_modules", "vitest"),
    "dir",
  );

  return {
    temporaryRoot,
    consumer,
    tarballs,
    packageVersions: options.packages.map((entry) =>
      tarballName(tarballs[entry.key]),
    ),
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (existsSync(temporaryRoot)) {
        throw new Error(`${options.consumerName} cleanup left its temporary root`);
      }
    },
  };
}
