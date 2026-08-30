import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  pnpm,
  prepareControlCohort,
  root,
  tangleLiveFixture,
  vitest,
} from "./lib/control-cohort.mjs";
import { prepareCliBridgeCohort } from "./lib/cli-bridge-cohort.mjs";

// Braid upstream-evidence runner. One invocation proves one UP-id and, on
// success, writes an evidence JSON whose path carries the UP-id. Braid reads
// GitHub API metadata only: the check-run name, the run head_sha, and the
// artifact name plus its sha256 digest. This runner produces the behavior the
// check-run name claims; the workflow attaches the artifact.
//
// Vacuity guard: vitest exits 0 when a name filter matches nothing (every test
// becomes "pending"). Each behavioral UP-id therefore asserts a minimum passed
// count from the JSON report, not the process exit code alone. A selector that
// matches too few tests fails the check.

// packages/<dir> for each publishable package the checks reference.
const PACKAGE_DIRECTORIES = {
  "@tangle-network/agent-interface": "agent-interface",
  "@tangle-network/agent-provider-cli-bridge": "agent-provider-cli-bridge",
  "@tangle-network/agent-provider-testkit": "agent-provider-testkit",
  "@tangle-network/agent-provider-tangle": "agent-provider-tangle",
};

function packageVersion(name) {
  const directory = PACKAGE_DIRECTORIES[name];
  if (!directory) throw new Error(`unknown package ${name}`);
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", directory, "package.json"), "utf8"),
  );
  return manifest.version;
}

function tagCommit() {
  return process.env.GITHUB_SHA ?? null;
}

function writeEvidence(upId, slug, body) {
  const directory = join(root, "artifacts");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${upId}-${slug}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

// Behavioral UP-ids run a named subset of the packed control cohort. minTests
// is the vacuity floor: the measured passed count for the selector on this
// commit. A drop below the floor means the selector no longer proves the
// behavior and the check fails.
const BEHAVIORAL = {
  "UP-01": {
    slug: "agent-interface",
    packages: ["@tangle-network/agent-interface"],
    files: ["interaction.test.ts"],
    pattern: "interaction capabilities|interaction acknowledgement",
    minTests: 13,
    summary:
      "Packed agent-interface interaction capability and acknowledgement contract.",
  },
  "UP-02": {
    slug: "agent-interface",
    packages: ["@tangle-network/agent-interface"],
    files: ["interaction.test.ts"],
    pattern: "interaction response command",
    minTests: 6,
    summary:
      "Packed agent-interface interaction response command binding contract.",
  },
  "UP-12": {
    slug: "agent-interface-and-tangle",
    packages: [
      "@tangle-network/agent-interface",
      "@tangle-network/agent-provider-tangle",
    ],
    files: ["control-conformance.test.ts", "tangle-control-consumer.test.ts"],
    pattern:
      "capability denial|adapts the actual public Sandbox instance without inventing branching",
    minTests: 9,
    summary:
      "Packed capability-denial conformance plus the packed Tangle public-boundary branching-denial proof.",
  },
  "UP-13": {
    slug: "agent-interface",
    packages: ["@tangle-network/agent-interface"],
    files: ["portable-context.test.ts", "control-conformance.test.ts"],
    pattern:
      "matches a fresh-session receipt exactly|rejects duplicate message identities|runPortableContextConformance",
    minTests: 3,
    summary:
      "Packed portable-context receipt identity contract plus the packed portable-context conformance suite.",
  },
  "UP-14": {
    slug: "agent-interface-and-tangle",
    packages: [
      "@tangle-network/agent-interface",
      "@tangle-network/agent-provider-tangle",
    ],
    files: [
      "workspace-branching.test.ts",
      "control-conformance.test.ts",
      "tangle-control-consumer.test.ts",
    ],
    pattern:
      "retry-safe workspace checkpoint|retry-safe environment fork|workspace cleanup acknowledgement|runWorkspaceBranchingConformance|binds result replay and cancellation to the dispatch receipt|fails closed when Sandbox does not prove an exact execution",
    minTests: 24,
    summary:
      "Packed workspace-branching idempotency contract plus its conformance suite plus the packed Tangle receipt-bound replay and fail-closed proofs.",
  },
};

// A test-only hook: override the descriptor selector to prove the vacuity
// guard. A selector that matches nothing must exit nonzero.
const PATTERN_OVERRIDE = process.env.UPSTREAM_CHECK_PATTERN_OVERRIDE;

function runCohortVitest(cohort, files, pattern) {
  const reportPath = join(cohort.temporaryRoot, "vitest-report.json");
  const args = [
    "run",
    ...files,
    "--root",
    cohort.consumer,
    "--config",
    join(cohort.consumer, "vitest.config.mjs"),
    "-t",
    pattern,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
  const result = spawnSync(vitest, args, {
    cwd: cohort.consumer,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = undefined;
  }
  return { status: result.status, stderr: result.stderr, report };
}

function assertPassingReport(upId, result, minTests) {
  const { status, stderr, report } = result;
  if (!report) {
    throw new Error(
      `${upId} produced no vitest JSON report (exit ${status}).\n${stderr}`,
    );
  }
  const {
    numTotalTests,
    numPassedTests,
    numFailedTests,
    numPendingTests,
  } = report;
  if (
    typeof numPassedTests !== "number" ||
    typeof numFailedTests !== "number"
  ) {
    throw new Error(
      `${upId} produced a report without numeric pass/fail counts (passed=${numPassedTests}, failed=${numFailedTests}).\n${stderr}`,
    );
  }
  if (status !== 0 || numFailedTests > 0) {
    throw new Error(
      `${upId} failed: ${numFailedTests} failed of ${numTotalTests} (exit ${status}).\n${stderr}`,
    );
  }
  if (numPassedTests < minTests) {
    throw new Error(
      `${upId} is vacuous: ${numPassedTests} tests passed, expected at least ${minTests}. The selector matched too few tests.`,
    );
  }
  return {
    numTotalTests,
    numPassedTests,
    numFailedTests,
    numPendingTests,
  };
}

function runBehavioral(upId) {
  const descriptor = BEHAVIORAL[upId];
  const pattern = PATTERN_OVERRIDE ?? descriptor.pattern;
  const command = `vitest run ${descriptor.files.join(" ")} -t ${JSON.stringify(pattern)}`;
  const cohort = prepareControlCohort();
  try {
    const result = runCohortVitest(
      cohort,
      descriptor.files,
      pattern,
    );
    const {
      numTotalTests,
      numPassedTests,
      numFailedTests,
      numPendingTests,
    } = assertPassingReport(upId, result, descriptor.minTests);
    const path = writeEvidence(upId, descriptor.slug, {
      upId,
      package: descriptor.packages[0],
      version: packageVersion(descriptor.packages[0]),
      packages: descriptor.packages.map((name) => ({
        name,
        version: packageVersion(name),
      })),
      tagCommit: tagCommit(),
      command,
      result: "success",
      evidence: {
        summary: descriptor.summary,
        files: descriptor.files,
        testNamePattern: pattern,
        numTotalTests,
        numPassedTests,
        numFailedTests,
        numPendingTests,
        minTests: descriptor.minTests,
        packedTarballs: cohort.packageVersions,
      },
      generatedAt: new Date().toISOString(),
    });
    console.log(
      `${upId}: ${numPassedTests} tests passed (>= ${descriptor.minTests}); evidence ${path}`,
    );
  } finally {
    cohort.cleanup();
  }
}

const CLI_BRIDGE_PROVIDER_CHECKS = {
  "UP-05": {
    pattern: "carries a canonical event stream through the real Bridge transport",
    minTests: 1,
    summary:
      "Packed CLI Bridge provider carries canonical reasoning, text, tool, plan, permission, usage, and terminal events through a real Bridge server.",
  },
  "UP-07": {
    pattern: "reattaches and replays a resolved interaction after Bridge restart",
    minTests: 1,
    summary:
      "Packed CLI Bridge provider replays identical interaction responses and rejects changed responses through a real Bridge server.",
  },
  "UP-08": {
    pattern:
      "isolates concurrent run identities through the real Bridge transport|answers a cancelled interaction with the cancelled acknowledgement",
    minTests: 2,
    summary:
      "Packed CLI Bridge provider proves replay, restart reconstruction, exact status, interaction response, and cancellation through a real Bridge server.",
  },
};

function requiredCliBridgeRoot() {
  const directory = process.env.CLI_BRIDGE_INTEGRATION_ROOT?.trim();
  if (!directory) {
    throw new Error(
      "CLI_BRIDGE_INTEGRATION_ROOT must name an installed cli-bridge source checkout",
    );
  }
  return directory;
}

function cliBridgeCommit(directory) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  });
  const commit = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(
      `could not resolve the cli-bridge commit at ${directory}: ${result.stderr}`,
    );
  }
  return commit;
}

function runCliBridgeProvider(upId) {
  const descriptor = CLI_BRIDGE_PROVIDER_CHECKS[upId];
  const bridgeRoot = requiredCliBridgeRoot();
  const cohort = prepareCliBridgeCohort();
  try {
    const result = runCohortVitest(
      cohort,
      ["cli-bridge.integration.test.ts"],
      PATTERN_OVERRIDE ?? descriptor.pattern,
    );
    const counts = assertPassingReport(upId, result, descriptor.minTests);
    const path = writeEvidence(upId, "agent-provider-cli-bridge-real", {
      upId,
      package: "@tangle-network/agent-provider-cli-bridge",
      version: packageVersion("@tangle-network/agent-provider-cli-bridge"),
      tagCommit: tagCommit(),
      command: `vitest run cli-bridge.integration.test.ts -t ${JSON.stringify(descriptor.pattern)}`,
      result: "success",
      evidence: {
        summary: descriptor.summary,
        cliBridgeCommit: cliBridgeCommit(bridgeRoot),
        packedTarballs: cohort.packageVersions,
        testNamePattern: descriptor.pattern,
        minTests: descriptor.minTests,
        ...counts,
      },
      generatedAt: new Date().toISOString(),
    });
    console.log(
      `${upId}: ${counts.numPassedTests} real Bridge tests passed; evidence ${path}`,
    );
  } finally {
    cohort.cleanup();
  }
}

function runCliBridgePolicy() {
  const upId = "UP-06";
  const bridgeRoot = requiredCliBridgeRoot();
  const reportPath = join(root, "artifacts", `${upId}-vitest-report.json`);
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const pattern = PATTERN_OVERRIDE ?? [
    "fails closed on session/request_permission instead of fabricating approval",
    "honors agent_profile.permissions over the headless allow defaults",
    "auto-denies an unrequested supported dialog through the durable response lane",
  ].join("|");
  const result = spawnSync(
    pnpm,
    [
      "exec",
      "vitest",
      "run",
      "tests/acp.test.ts",
      "tests/profile-mcp.test.ts",
      "tests/retained-sessions.test.ts",
      "-t",
      pattern,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: bridgeRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = undefined;
  }
  const counts = assertPassingReport(
    upId,
    { status: result.status, stderr: result.stderr, report },
    3,
  );
  const path = writeEvidence(upId, "cli-bridge-interaction-policy", {
    upId,
    package: "@tangle-network/agent-provider-cli-bridge",
    version: packageVersion("@tangle-network/agent-provider-cli-bridge"),
    tagCommit: tagCommit(),
    command:
      "vitest run acp, profile-permission, and retained-interaction policy tests",
    result: "success",
    evidence: {
      summary:
        "CLI Bridge refuses unanswerable ACP permissions, honors profile-scoped OpenCode policy, and denies unrequested native dialogs.",
      cliBridgeCommit: cliBridgeCommit(bridgeRoot),
      testNamePattern: pattern,
      minTests: 3,
      ...counts,
    },
    generatedAt: new Date().toISOString(),
  });
  console.log(`${upId}: ${counts.numPassedTests} policy tests passed; evidence ${path}`);
}

function publishablePackages() {
  const packagesRoot = join(root, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name, "package.json"))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")))
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => ({ name: manifest.name, version: manifest.version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// UP-11 is the packed-artifact contract for every publishable package. It
// delegates to the existing check so the two never drift.
function runUp11() {
  const result = spawnSync(pnpm, ["check:package-artifacts"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `UP-11 check:package-artifacts failed (exit ${result.status}).\n${result.stdout}\n${result.stderr}`,
    );
  }
  const packages = publishablePackages();
  if (packages.length === 0) {
    throw new Error(
      "UP-11 is vacuous: no publishable packages were discovered.",
    );
  }
  const summary =
    result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1) ?? "";
  const path = writeEvidence("UP-11", "all-publishable-packages", {
    upId: "UP-11",
    package: "all-publishable-packages",
    version: null,
    packages,
    tagCommit: tagCommit(),
    command: "pnpm check:package-artifacts",
    result: "success",
    evidence: {
      summary,
      packages,
    },
    generatedAt: new Date().toISOString(),
  });
  console.log(`UP-11: ${packages.length} packages checked; evidence ${path}`);
}

const LIVE_TANGLE = {
  "UP-09": {
    mode: "retained",
    slug: "agent-provider-tangle-live-retained",
    summary:
      "Packed Tangle provider proves hosted create replay, retained dispatch, event replay, permission response, cancellation replay, restart lookup, and cleanup.",
  },
  "UP-14": {
    mode: "workspace",
    slug: "agent-provider-tangle-live-workspace",
    summary:
      "Packed Tangle provider proves hosted checkpoint and environment-fork retries, fresh-process lookup, independent workspace state, and confirmed cleanup.",
  },
};

function runLiveTangle(upId) {
  const descriptor = LIVE_TANGLE[upId];
  if (!process.env.TANGLE_API_KEY?.trim()) {
    throw new Error(`${upId} requires TANGLE_API_KEY for the hosted Sandbox API`);
  }
  const cohort = prepareControlCohort();
  try {
    const result = spawnSync(
      process.execPath,
      [join(cohort.consumer, tangleLiveFixture), descriptor.mode],
      {
        cwd: cohort.consumer,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 25 * 60 * 1_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `${upId} live Tangle fixture failed (exit ${result.status}).\n${result.stderr}`,
      );
    }
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) {
      throw new Error(`${upId} live Tangle fixture returned invalid output`);
    }
    const report = JSON.parse(lines[0]);
    const path = writeEvidence(upId, descriptor.slug, {
      upId,
      package: "@tangle-network/agent-provider-tangle",
      version: packageVersion("@tangle-network/agent-provider-tangle"),
      packages: [
        "@tangle-network/agent-interface",
        "@tangle-network/agent-provider-testkit",
        "@tangle-network/agent-provider-tangle",
      ].map((name) => ({ name, version: packageVersion(name) })),
      tagCommit: tagCommit(),
      command: `node ${tangleLiveFixture} ${descriptor.mode}`,
      result: "success",
      evidence: {
        summary: descriptor.summary,
        packedTarballs: cohort.packageVersions,
        modelProvider: process.env.TANGLE_MODEL_PROVIDER ?? null,
        model: process.env.TANGLE_MODEL ?? null,
        report,
      },
      generatedAt: new Date().toISOString(),
    });
    console.log(`${upId}: live Tangle ${descriptor.mode} proof passed; evidence ${path}`);
  } finally {
    cohort.cleanup();
  }
}

const HANDLERS = {
  "UP-01": () => runBehavioral("UP-01"),
  "UP-02": () => runBehavioral("UP-02"),
  "UP-05": () => runCliBridgeProvider("UP-05"),
  "UP-06": runCliBridgePolicy,
  "UP-07": () => runCliBridgeProvider("UP-07"),
  "UP-08": () => runCliBridgeProvider("UP-08"),
  "UP-09": () => runLiveTangle("UP-09"),
  "UP-11": runUp11,
  "UP-12": () => runBehavioral("UP-12"),
  "UP-13": () => runBehavioral("UP-13"),
  "UP-14": () => runLiveTangle("UP-14"),
};

async function main() {
  const upId = process.argv[2];
  if (!upId) {
    console.error("usage: node scripts/upstream-check.mjs <UP-id>");
    process.exit(2);
  }
  const handler = HANDLERS[upId];
  if (!handler) {
    console.error(
      `unknown UP id: ${upId}. Known ids: ${Object.keys(HANDLERS).join(", ")}`,
    );
    process.exit(2);
  }
  await handler();
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
