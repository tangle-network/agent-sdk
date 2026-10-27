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
    response.end(JSON.stringify(result.success ? { success: true } : { issues: result.error.issues }));
  } catch {
    response.writeHead(500).end();
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
    const rejection = await response.json();
    assert.ok(Array.isArray(rejection.issues) && rejection.issues.length > 0 && rejection.issues.length <= 3);
  }
  let reads = 0;
  const tooMany = {};
  for (let i = 0; i < 257; i++) Object.defineProperty(tooMany, `key${i}`, {
    enumerable: true, get() { reads++; return true; },
  });
  assert.equal(agentProfileSchema.safeParse({ tools: tooMany }).success, false);
  assert.equal(reads, 0, "cardinality admission must precede reading or encoding entries");

  // Malformed training must abort before the outer profile's recursive record walk.
  const malformedTraining = '{"metadata":{"training":{"receipt":{},"ancestors":[],"unknown":' +
    '{"next":'.repeat(20_000) + 'null' + '}'.repeat(20_000) + '}}}';
  const malformedFile = join(directory, "malformed-training.json");
  await writeFile(malformedFile, malformedTraining);
  const malformed = agentProfileSchema.safeParse(JSON.parse(await readFile(malformedFile, "utf8")));
  assert.equal(malformed.success, false);
  assert.ok(malformed.error.issues.length > 0 && malformed.error.issues.length <= 32);
  const malformedResponse = await fetch(endpoint, { method: "POST", body: await readFile(malformedFile) });
  assert.equal(malformedResponse.status, 400);
  const malformedIssues = (await malformedResponse.json()).issues;
  assert.ok(Array.isArray(malformedIssues) && malformedIssues.length > 0 && malformedIssues.length <= 32,
    "a bounded validation result, not a caught stack overflow");
  let unadmittedReads = 0;
  const unadmittedTraining = { receipt: {}, ancestors: [] };
  Object.defineProperty(unadmittedTraining, "unknown", {
    enumerable: true, get() { unadmittedReads++; throw new Error("unadmitted training was traversed"); },
  });
  assert.equal(agentProfileSchema.safeParse({ metadata: { training: unadmittedTraining } }).success, false);
  assert.equal(unadmittedReads, 0);
  const omittedKeys = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, undefined]));
  assert.equal(agentProfileSchema.safeParse({ metadata: { payload: omittedKeys(257) } }).success, false);
  assert.throws(() => snapshotAgentProfile({ metadata: { payload: omittedKeys(257) } }));
  const aggregateOmissions = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`map${i}`, omittedKeys(256)]));
  assert.equal(agentProfileSchema.safeParse({ metadata: { payload: aggregateOmissions } }).success, false);
  assert.equal(api.isBoundedEventContentJson(aggregateOmissions, { omitUndefinedObjectFields: true }), false);
  const boundedOmissions = { metadata: { payload: omittedKeys(256) } };
  assert.equal(Object.keys(snapshotAgentProfile(boundedOmissions).metadata.payload).length, 256);
  assert.equal(api.canonicalAgentProfileDigest(boundedOmissions), api.canonicalAgentProfileDigest({ metadata: { payload: {} } }));
  assert.equal(api.isBoundedEventContentJson(omittedKeys(257), { omitUndefinedObjectFields: true }), false);
  assert.equal(api.isBoundedEventContentJson(omittedKeys(256), { omitUndefinedObjectFields: true }), true);

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
  // Every negative starts from admitted detached data, independent of source-mutation controls.
  const pristineReceipt = structuredClone(snapshot.metadata.training.receipt);
  const exactArrayBound = (result, maximum, path) => {
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    const issue = result.error.issues[0];
    assert.equal(issue.code, "too_big");
    assert.equal(issue.origin, "array");
    assert.equal(issue.maximum, maximum);
    assert.deepEqual(issue.path, path);
  };
  const excessTasks = [...pristineReceipt.dataset.tasks, {
    benchmark: "retained", task: "task-10000", contentDigest: hash("task-10000"),
  }];
  exactArrayBound(agentTrainingDatasetIdentitySchema.safeParse({ ...pristineReceipt.dataset,
    tasks: excessTasks, taskSetDigest: digest(excessTasks) }), 10_000, ["tasks"]);
  const linkedTraining = (ancestors) => {
    const chain = [];
    const tasks = pristineReceipt.dataset.tasks.slice(0, 1);
    for (let i = ancestors; i >= 0; i--) chain.unshift({ ...pristineReceipt,
      executionRef: hash(`chain-${i}`), parentReceiptDigest: chain.length ? digest(chain[0]) : null,
      dataset: { ...pristineReceipt.dataset, tasks, taskSetDigest: digest(tasks) },
    });
    return { receipt: chain[0], ancestors: chain.slice(1) };
  };
  assert.equal(schemas.agentProfileTrainingSchema.safeParse(linkedTraining(8)).success, true);
  exactArrayBound(schemas.agentProfileTrainingSchema.safeParse(linkedTraining(9)), 8, ["ancestors"]);
  const parameters = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`param${i}`, 0]));
  assert.equal(schemas.agentTrainingParametersSchema.safeParse(parameters(100)).success, true);
  const excessParameters = schemas.agentTrainingParametersSchema.safeParse(parameters(101));
  assert.equal(excessParameters.success, false);
  assert.deepEqual(excessParameters.error.issues.map(({ code, path, message }) => ({ code, path, message })),
    [{ code: "custom", path: [], message: "record exceeds the contract bounds" }]);
  const unknownTraining = agentProfileSchema.safeParse({ metadata: {
    training: { receipt: pristineReceipt, ancestors: [], unknown: true },
  } });
  assert.equal(unknownTraining.success, false);
  assert.ok(unknownTraining.error.issues.some((issue) => issue.message.includes("unknown")));
  const knowledge = (count) => Array.from({ length: count }, (_, i) => ({
    sourceId: `source_${i}`, generation: `kg_${i.toString(16).padStart(64, "0")}`,
  }));
  assert.equal(agentProfileSchema.safeParse({ resources: { knowledge: knowledge(16) } }).success, true);
  exactArrayBound(agentProfileSchema.safeParse({ resources: { knowledge: knowledge(17) } }), 16, ["resources", "knowledge"]);

  let containerReads = 0;
  const container = {};
  Object.defineProperty(container, "payload", { enumerable: true, get() {
    containerReads++; throw new Error("metadata container getter executed");
  } });
  assert.equal(agentProfileSchema.safeParse({ metadata: container }).success, false);
  assert.equal(containerReads, 0);
  const nestedSparse = agentProfileSchema.safeParse({ model: { metadata: { hint: [, 0] } } });
  assert.ok(!nestedSparse.success && nestedSparse.error.issues.some((issue) =>
    // Record keys reach issue paths hex-encoded by own-property-record (pre-existing), so match the frame around them.
    /sparse array hole/.test(issue.message) && issue.path.slice(0, 2).join(".") === "model.metadata" && issue.path.at(-1) === 0),
    "nested metadata keeps its path-specific refusal");
  let lateReads = 0;
  const mutable = { score: 1 };
  const lateProfile = { metadata: { payload: mutable } };
  Object.defineProperty(lateProfile, "extensions", { enumerable: true, get() {
    lateReads++; mutable.score = 2; mutable.unadmitted = JSON.parse('{"next":'.repeat(20_000) + 'null' + '}'.repeat(20_000));
    return undefined;
  } });
  const isolated = snapshotAgentProfile(lateProfile);
  assert.equal(lateReads, 1);
  assert.deepEqual(isolated.metadata.payload, { score: 1 });

  const proxyBindings = Array.from({ length: api.CONTRACT_MAX_ARRAY_LENGTH }, (_, i) => ({
    envName: `SECRET_${i}`, secretRef: { kind: "secret-ref", key: `service-key-${i}` },
    hosts: ["service.example.com"], presentation: { type: "bearer" },
  }));
  const parentMap = (count) => Object.fromEntries(proxyBindings.slice(0, count).map((binding) => [binding.envName, null]));
  for (const count of [257, api.CONTRACT_MAX_ARRAY_LENGTH]) {
    assert.equal(api.ProxySecretParentsSchema.safeParse(parentMap(count)).success, true);
    assert.equal(api.isProxySecretParentsTotal(proxyBindings.slice(0, count), parentMap(count)), true);
  }
  assert.equal(api.ProxySecretParentsSchema.safeParse({ ...parentMap(proxyBindings.length), EXTRA: null }).success, false);
  assert.equal(api.ProxySecretParentsSchema.safeParse({ "invalid-name": null }).success, false);
  assert.equal(api.ProxySecretParentsSchema.safeParse({ SECRET_0: 7 }).success, false);
  assert.equal(api.isProxySecretParentsTotal(proxyBindings, parentMap(proxyBindings.length - 1)), false);

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
    canonicalDigestUnchanged: true, recordGetterReadsBeforeRefusal: reads, opaqueAccessorReads: accessorReads,
    malformedTrainingDepth: 20_000, unadmittedTrainingGetterReads: unadmittedReads,
    pristineLimitControls: true, validLinkedAncestors: 8, distinctKnowledgeBoundary: 16,
    proxyParentContractPreserved: api.CONTRACT_MAX_ARRAY_LENGTH, metadataContainerGetterReads: containerReads, lateMutationDetached: true,
    undefinedOwnKeyOverflowRefused: true, boundedUndefinedFieldsPreserved: 256 }));
} finally {
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
