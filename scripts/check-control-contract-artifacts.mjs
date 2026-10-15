import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  interfaceTests,
  prepareControlCohort,
  run,
  tangleFixtureTest,
  testkitTest,
  tsc,
  vitest,
} from "./lib/control-cohort.mjs";

const readOnlyConsumerIndex = process.argv.indexOf("--read-only-consumer");
if (readOnlyConsumerIndex !== -1) {
  const consumer = process.argv[readOnlyConsumerIndex + 1];
  if (!consumer) throw new Error("--read-only-consumer requires an installed consumer directory");
  await checkReadOnlyConsumer(resolve(consumer));
} else {
const cohort = prepareControlCohort();
try {
  await checkReadOnlyExports(cohort.consumer);
  run(tsc, ["-p", "tsconfig.json"], { cwd: cohort.consumer });
  const testOutput = run(
    vitest,
    [
      "run",
      ...interfaceTests,
      testkitTest,
      tangleFixtureTest,
      "--root",
      cohort.consumer,
      "--config",
      join(cohort.consumer, "vitest.config.mjs"),
    ],
    { cwd: cohort.consumer },
  );
  const testSummary = testOutput
    .split("\n")
    .filter((line) => /Test Files|Tests\s+\d+ passed/.test(line.trim()))
    .map((line) => line.trim())
    .join("; ");
  console.log(
    `Packed control contracts passed: ${cohort.packageVersions.join(", ")}; ${testSummary}`,
  );
} finally {
  cohort.cleanup();
}

}

// Check both supported entry points in the actual installed artifact, not a source shim.
async function checkReadOnlyExports(consumer) {
  const consumerRequire = createRequire(join(consumer, "package.json"));
  const canonical = await import(pathToFileURL(consumerRequire.resolve("@tangle-network/agent-interface/environment-provider")).href);
  const root = await import(pathToFileURL(consumerRequire.resolve("@tangle-network/agent-interface")).href);
  assert.equal(root.AgentEnvironmentReadOnlyGetOptionsSchema, canonical.AgentEnvironmentReadOnlyGetOptionsSchema,
    "readOnly discovery schema must be exported from root and environment-provider");
  assert.equal(canonical.AgentEnvironmentReadOnlyGetOptionsSchema.safeParse({ readOnly: true }).success, true);
  assert.equal(canonical.AgentEnvironmentGetOptionsSchema.safeParse({ readOnly: true }).success, false);
  return canonical;
}

// Consume archives already installed by the maintained gate. This mode neither builds nor
// installs another cohort: its legacy alias must be the independently selected registry package.
async function checkReadOnlyConsumer(consumer) {
  const consumerRequire = createRequire(join(consumer, "package.json"));
  const canonicalEntry = consumerRequire.resolve("@tangle-network/agent-interface/environment-provider");
  const legacyEntry = consumerRequire.resolve("legacy-tangle-provider");
  const legacyRequire = createRequire(legacyEntry);
  assert.equal(realpathSync(legacyRequire.resolve("@tangle-network/agent-interface/environment-provider")),
    realpathSync(canonicalEntry), "legacy Provider must actually resolve the candidate canonical archive");
  await checkReadOnlyExports(consumer);
  const legacy = await import(pathToFileURL(legacyEntry).href);
  const current = await import(pathToFileURL(consumerRequire.resolve("@tangle-network/agent-provider-tangle")).href);
  const calls = { gets: 0, resumes: 0, turns: 0, guestCapabilities: 0, sessionProbes: 0 };
  const box = {
    id: "retained-fixture", status: "stopped",
    async resume() { calls.resumes++; },
    async *streamPrompt() { calls.turns++; },
    async capabilities() { calls.guestCapabilities++; throw new Error("stopped sidecar 503"); },
    session() { calls.sessionProbes++; throw new Error("snapshot cannot probe a session"); },
  };
  const client = {
    async create() { throw new Error("discovery cannot allocate"); },
    async get() { calls.gets++; return box; },
  };
  const oldProvider = legacy.createTangleProvider({ client, requireNativeSessionCapture: true });
  await assert.rejects(oldProvider.get(box.id, { readOnly: true }), /readOnly|read.only/i);
  assert.deepEqual(calls, { gets: 0, resumes: 0, turns: 0, guestCapabilities: 0, sessionProbes: 0 });
  const provider = current.createTangleProvider({ client, requireNativeSessionCapture: true });
  const snapshot = await provider.get(box.id, { readOnly: true });
  assert.equal(snapshot.id, box.id);
  assert.equal(await snapshot.status(), "stopped");
  assert.equal(snapshot.dispatch, undefined);
  assert.equal(snapshot.write, undefined);
  assert.equal(snapshot.destroy, undefined);
  assert.equal(snapshot.capabilities.streaming.live, false);
  assert.equal(snapshot.capabilities.workspace.exec, false);
  await assert.rejects(async () => { for await (const event of snapshot.stream({ prompt: "refuse" })) {} }, /read.only/i);
  assert.deepEqual(calls, { gets: 1, resumes: 0, turns: 0, guestCapabilities: 0, sessionProbes: 0 });
  console.log(JSON.stringify({ readOnlyInstalledCompatibility: "PASS", legacySharesCandidateCanonical: true,
    legacyRejectedBeforeLookup: true, currentSnapshotOnly: true, calls }));
}
