import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  pnpm,
  prepareControlCohort,
  root,
  vitest,
} from "./lib/control-cohort.mjs";

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

function runBehavioral(upId) {
  const descriptor = BEHAVIORAL[upId];
  const pattern = PATTERN_OVERRIDE ?? descriptor.pattern;
  const command = `vitest run ${descriptor.files.join(" ")} -t ${JSON.stringify(pattern)}`;
  const cohort = prepareControlCohort();
  try {
    const { status, stderr, report } = runCohortVitest(
      cohort,
      descriptor.files,
      pattern,
    );
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
    // A reporter that omits a numeric count must fail closed. Without this a
    // future undefined count would satisfy neither `> 0` nor `< minTests` and
    // silently bypass the vacuity floor.
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
    if (numPassedTests < descriptor.minTests) {
      throw new Error(
        `${upId} is vacuous: ${numPassedTests} tests passed, expected at least ${descriptor.minTests}. The selector matched too few tests.`,
      );
    }
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

// UP-09 is a live Tangle sandbox roundtrip. Operator decision that unblocks it:
// provide the CI secrets below and set vars.UPSTREAM_LIVE_EVIDENCE=true. The
// public @tangle-network/sandbox client is chain-backed, so the "key + url"
// operator inputs map to a private key, an RPC url, and a Tangle service id.
async function runUp09() {
  const privateKey = process.env.TANGLE_CI_SANDBOX_KEY;
  const rpcUrl = process.env.TANGLE_CI_SANDBOX_URL;
  const serviceId = process.env.TANGLE_CI_SANDBOX_SERVICE_ID;
  if (!privateKey || !rpcUrl || !serviceId) {
    throw new Error(
      "UP-09 requires TANGLE_CI_SANDBOX_KEY (0x private key), TANGLE_CI_SANDBOX_URL (rpc url), and TANGLE_CI_SANDBOX_SERVICE_ID (service id). These operator secrets unblock the live Tangle roundtrip.",
    );
  }
  const sandboxEntry = createRequire(
    join(root, "packages", "agent-provider-tangle", "package.json"),
  ).resolve("@tangle-network/sandbox");
  const { TangleSandboxClient } = await import(
    pathToFileURL(sandboxEntry).href
  );
  const client = new TangleSandboxClient({
    serviceId: BigInt(serviceId),
    privateKey,
    rpcUrl,
  });
  const box = await client.create();
  try {
    const result = await box.prompt("Reply with the single word: ready.");
    if (!result || result.success !== true) {
      throw new Error(
        `UP-09 live prompt did not succeed: status=${result?.status ?? "unknown"}`,
      );
    }
    const path = writeEvidence("UP-09", "agent-provider-tangle-live", {
      upId: "UP-09",
      package: "@tangle-network/agent-provider-tangle",
      version: packageVersion("@tangle-network/agent-provider-tangle"),
      tagCommit: tagCommit(),
      command: "live Tangle sandbox create + prompt + delete",
      result: "success",
      evidence: {
        summary:
          "Live Tangle sandbox create, prompt, and delete against the operator endpoint.",
        sandboxId: box.id ?? null,
        promptStatus: result.status,
      },
      generatedAt: new Date().toISOString(),
    });
    console.log(`UP-09: live Tangle roundtrip passed; evidence ${path}`);
  } finally {
    await box.delete();
  }
}

// UP-05..08 are live cli-bridge conformance checks. Operator decision that
// unblocks them: stand up a bridge server that implements the bridge wire
// protocol and expose its address as vars.CLI_BRIDGE_TEST_SERVER. The shipped
// cli-bridge tests mock the HTTP transport in-process, so a live check needs a
// packed cli-bridge cohort pointed at the real server. This handler fails loud
// until that server exists rather than fabricating success.
const CLI_BRIDGE_BEHAVIORS = {
  "UP-05": "canonical event stream",
  "UP-06": "cancellation",
  "UP-07": "reattach and replay",
  "UP-08": "run-identity isolation",
};

function runCliBridgeGated(upId) {
  const server = process.env.CLI_BRIDGE_TEST_SERVER;
  if (!server) {
    throw new Error(
      `${upId} requires vars.CLI_BRIDGE_TEST_SERVER, a live bridge server address. It is gated behind vars.UPSTREAM_LIVE_EVIDENCE.`,
    );
  }
  const behavior = CLI_BRIDGE_BEHAVIORS[upId];
  throw new Error(
    `${upId} (${behavior}) needs a maintainer decision. The shipped cli-bridge tests mock the HTTP transport in-process. A live upstream-evidence check must run the cli-bridge ${behavior} behavior against a bridge conformance server at ${server}. Wire a packed cli-bridge cohort to that server, then implement this handler. This check fails loud until then.`,
  );
}

const HANDLERS = {
  "UP-01": () => runBehavioral("UP-01"),
  "UP-02": () => runBehavioral("UP-02"),
  "UP-05": () => runCliBridgeGated("UP-05"),
  "UP-06": () => runCliBridgeGated("UP-06"),
  "UP-07": () => runCliBridgeGated("UP-07"),
  "UP-08": () => runCliBridgeGated("UP-08"),
  "UP-09": runUp09,
  "UP-11": runUp11,
  "UP-12": () => runBehavioral("UP-12"),
  "UP-13": () => runBehavioral("UP-13"),
  "UP-14": () => runBehavioral("UP-14"),
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
