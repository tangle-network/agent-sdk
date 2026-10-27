import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run inside an isolated consumer installed from this candidate's actual tarball.
const require = createRequire(join(resolve(process.argv[2] ?? process.cwd()), "package.json"));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const api = await load("@tangle-network/agent-interface");
const schemas = await load("@tangle-network/agent-interface/profile-schema");
const { snapshotAgentProfile } = await load("@tangle-network/agent-interface/profile-snapshot");
const { agentProfileSchema, agentTrainingDatasetIdentitySchema } = schemas;
const digest = api.canonicalCandidateDigest;
const hash = (text) => api.sha256Utf8(text);
const directory = await mkdtemp(join(tmpdir(), "profile-admission-"));
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = agentProfileSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(result.success ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(result.success ? { success: true } : { issues: result.error.issues.length }));
  } catch {
    response.writeHead(400).end();
  }
});
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    { resources: { files: Array(65_536).fill(0) } },
    { tags: Array(65_536).fill(0) },
    { hooks: { run: Array(65_536).fill(0) } },
    { mcp: { server: { command: "tool", args: Array(65_536).fill(0) } } },
    { tools: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`tool${i}`, true])) },
  ];
  for (const [index, candidate] of cases.entries()) {
    const file = join(directory, `invalid-${index}.json`);
    await writeFile(file, JSON.stringify(candidate));
    const result = agentProfileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    assert.equal(result.success, false);
    assert.ok(result.error.issues.length <= 3, "invalid children must not amplify errors");
    const response = await fetch(endpoint, { method: "POST", body: await readFile(file) });
    assert.equal(response.status, 400);
  }
  let reads = 0;
  const tooMany = {};
  for (let i = 0; i < 257; i++) Object.defineProperty(tooMany, `key${i}`, {
    enumerable: true, get() { reads++; return true; },
  });
  assert.equal(agentProfileSchema.safeParse({ tools: tooMany }).success, false);
  assert.equal(reads, 0, "cardinality admission must precede reading or encoding entries");

  const tasks = Array.from({ length: 10_000 }, (_, i) => ({
    benchmark: "retained", task: `task-${String(i).padStart(5, "0")}`, contentDigest: hash(`task-${i}`),
  }));
  const artifactDigest = hash("artifact");
  const receipt = {
    version: 1, parentProfileDigest: hash("parent"), parentReceiptDigest: null,
    executionRef: hash("executor"),
    dataset: { digest: hash("dataset"), taskSetDigest: digest(tasks), tasks },
    trainer: { mode: "command", id: "fixture-trainer", revision: hash("trainer"), parameters: { epochs: 1 } },
    checkpoint: { artifactDigest, artifactBytes: 10,
      routerModelId: api.trainedModelIdForArtifact(artifactDigest), servingDigest: hash("serving") },
  };
  const nested = { score: 1 };
  const profile = {
    name: "retained-training", harness: "opencode",
    model: { provider: "openai-compat", default: receipt.checkpoint.routerModelId },
    metadata: { training: { receipt, ancestors: [] }, nested, explicitUndefined: undefined, negativeZero: -0 },
    extensions: { local: undefined },
  };
  const before = api.canonicalAgentProfileDigest(profile);
  const parsed = agentProfileSchema.parse(profile);
  const snapshot = snapshotAgentProfile(profile);
  assert.equal(api.canonicalAgentProfileDigest(parsed), before);
  assert.equal(api.canonicalAgentProfileDigest(snapshot), before);
  assert.equal(snapshot.metadata.training.receipt.dataset.tasks.length, 10_000);
  assert.equal(Object.hasOwn(snapshot.metadata, "explicitUndefined"), true);
  assert.equal(Object.is(snapshot.metadata.negativeZero, -0), true);
  nested.score = 2;
  tasks[0].task = "changed-at-source";
  assert.equal(snapshot.metadata.nested.score, 1);
  assert.equal(snapshot.metadata.training.receipt.dataset.tasks[0].task, "task-00000");
  assert.ok(Object.isFrozen(snapshot.metadata.nested));
  const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(snapshot) });
  assert.equal(response.status, 200);
  const excess = { ...receipt.dataset, tasks: Array(10_001).fill(receipt.dataset.tasks[1]) };
  assert.equal(agentTrainingDatasetIdentitySchema.safeParse(excess).success, false);
  assert.equal(schemas.agentProfileTrainingSchema.safeParse({ receipt, ancestors: Array(9).fill(receipt) }).success, false);
  const parameters = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`param${i}`, 0]));
  assert.equal(schemas.agentTrainingParametersSchema.safeParse(parameters).success, false);
  assert.equal(agentProfileSchema.safeParse({ metadata: { training: { receipt, ancestors: [], unknown: true } } }).success, false);
  assert.equal(agentProfileSchema.safeParse({ resources: { knowledge: Array(17).fill({ sourceId: "x", generation: `kg_${"0".repeat(64)}` }) } }).success, false);

  const cycle = {}; cycle.self = cycle;
  assert.throws(() => snapshotAgentProfile({ metadata: { cycle } }));
  let accessorReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "moving", { enumerable: true, get() { accessorReads++; return []; } });
  assert.throws(() => snapshotAgentProfile({ metadata: { accessor } }));
  assert.equal(accessorReads, 0, "opaque accessors cannot change after admission");
  assert.equal(typeof agentProfileSchema.shape.mcp.unwrap().safeParse, "function");
  assert.equal(typeof schemas.agentSubagentProfileSchema.omit({ metadata: true }).extend({}).safeParse, "function");
  assert.equal(schemas.agentProfileJsonSchema.type, "object");
  console.log(JSON.stringify({ result: "PASS", installedPublicPackage: require.resolve("@tangle-network/agent-interface"),
    fileAndHttpRefusals: cases.length, validTrainingTasks: 10_000, sourceMutationDetached: true,
    canonicalDigestUnchanged: true, recordGetterReadsBeforeRefusal: reads, opaqueAccessorReads: accessorReads }));
} finally {
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
