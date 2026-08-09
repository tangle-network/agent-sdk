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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const executableSuffix = process.platform === "win32" ? ".cmd" : "";
const vitest = join(
  root,
  "packages",
  "agent-provider-testkit",
  "node_modules",
  ".bin",
  `vitest${executableSuffix}`,
);
const tsc = join(
  root,
  "packages",
  "agent-interface",
  "node_modules",
  ".bin",
  `tsc${executableSuffix}`,
);

function run(command, args, options = {}) {
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

run(pnpm, ["--filter", "@tangle-network/agent-interface", "build"]);
run(pnpm, ["--filter", "@tangle-network/agent-provider-testkit", "build"]);
run(pnpm, ["--filter", "@tangle-network/agent-provider-tangle", "build"]);

const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-control-artifacts-"));
try {
  const tarballs = join(temporaryRoot, "tarballs");
  const consumer = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  const interfaceTarball = pack(
    join(root, "packages", "agent-interface"),
    tarballs,
  );
  const testkitTarball = pack(
    join(root, "packages", "agent-provider-testkit"),
    tarballs,
  );
  const tangleTarball = pack(
    join(root, "packages", "agent-provider-tangle"),
    tarballs,
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
          "@tangle-network/sandbox": "0.17.0",
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
    join(
      root,
      "packages",
      "agent-provider-testkit",
      "node_modules",
      "vitest",
    ),
    join(consumer, "node_modules", "vitest"),
    "dir",
  );

  const interfaceTests = [
    "environment-provider.test.ts",
    "interaction.test.ts",
    "portable-context.test.ts",
    "runtime-control.test.ts",
    "workspace-branching.test.ts",
  ];
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
    join(consumer, "control-conformance.test.ts"),
  );
  copyFileSync(
    join(root, "scripts", "fixtures", "tangle-control-consumer.test.ts"),
    join(consumer, "tangle-control-consumer.test.ts"),
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
    writeFileSync(
      join(consumer, `${shim}.ts`),
      `export * from "${source}";\n`,
    );
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

  run(tsc, ["-p", "tsconfig.json"], { cwd: consumer });
  const testOutput = run(
    vitest,
    [
      "run",
      ...interfaceTests,
      "control-conformance.test.ts",
      "tangle-control-consumer.test.ts",
      "--root",
      consumer,
      "--config",
      join(consumer, "vitest.config.mjs"),
    ],
    { cwd: consumer },
  );
  const packageVersions = [
    interfaceTarball,
    testkitTarball,
    tangleTarball,
  ].map((tarball) => {
    const filename = tarball.split(/[\\/]/).at(-1);
    return filename ?? tarball;
  });
  const testSummary = testOutput
    .split("\n")
    .filter((line) => /Test Files|Tests\s+\d+ passed/.test(line.trim()))
    .map((line) => line.trim())
    .join("; ");
  console.log(
    `Packed control contracts passed: ${packageVersions.join(", ")}; ${testSummary}`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
