import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BudgetSchema, ContinuityModeSchema, MapItemFailurePolicySchema, JsonScalarSchema,
  GraphEdgeSchema, GraphNodeSchema, GraphRunRecordSchema,
  GraphTopologySchema, StoredGraphSchema, RuntimeRunCoordinatesSchema,
  canonicalCandidateBytes, agentProfileSchema,
} from '@tangle-network/agent-interface';
for (const mode of ['fresh', 'resume']) assert.equal(ContinuityModeSchema.safeParse(mode).success, true);
assert.equal(ContinuityModeSchema.safeParse('continue').success, false);
for (const policy of ['all-or-refuse', 'settled-subset']) assert.equal(MapItemFailurePolicySchema.safeParse(policy).success, true);
assert.equal(MapItemFailurePolicySchema.safeParse('ignore').success, false);
for (const scalar of ['valid\u{1f600}', 0, true, null]) assert.equal(JsonScalarSchema.safeParse(scalar).success, true);
assert.equal(JsonScalarSchema.safeParse('\ud800').success, false);
const directory = process.argv[2];
assert.ok(directory);
const profile = { name: ' raw profile ', prompt: { systemPrompt: 'same bytes\n', instructions: [] }, tools: {}, metadata: { source: { preserved: true } } };
assert.equal(agentProfileSchema.safeParse(profile).success, true);
const node = { id: 'root', profile, futureNode: ['kept'] };
const directive = { surface: 'prompt-surface', version: 2, futureDirective: true };
const budget = { maxIterations: 8, maxTokens: 200, maxUsd: 1.25, deadlineMs: 9000, resources: { cpu: { unit: 'seconds', limit: 7, futureLimit: null } } };
const nested = { nodes: [node], edges: [], entry: [{ node: 'root', task: { input: 'raw task' } }], gates: [{ id: 'g', question: '?', choices: ['yes', 'no'] }] };
const edges = [
  { kind: 'delegates', from: 'root', to: 'child', directive, maxTraversals: 3, continuity: 'resume' },
  { kind: 'analyzes', analyst: 'lens', over: ['root', 'child'], to: 'root', directive, maxTraversals: 4 },
  { kind: 'maps', from: 'root', pointer: '/items', graph: nested, join: 'root', directive, maxItems: 2, concurrency: 1, onItemFailure: 'settled-subset', itemBudget: { maxTokens: 3, resources: {} } },
  { kind: 'routes', from: 'root', to: ['a', 'b'], directive, when: { all: [{ node: 'root', pointer: '/ok', equals: true }, { pointer: '/value', in: [1, 'one', false, null] }, { pointer: '/present', exists: false }] }, evidence: ['a'], maxTraversals: 2, continuity: 'fresh' },
  { kind: 'routes', from: ['a', 'b'], to: { finish: 'winner' }, directive },
  { kind: 'routes', from: 'root', to: { stop: 'reason' }, directive },
];
const graph = { digest: 'owned-elsewhere', nodes: [node], edges, budget, deliverable: { describe: 'text', checkRef: 'checker', futureCheck: true }, entry: nested.entry, gates: nested.gates, futureGraph: { x: 1 } };
Object.defineProperty(graph, '__proto__', { value: { retainedAsData: true }, enumerable: true });
const observed = { digest: 'observed-owned-elsewhere', observed: true, nodes: [{ id: 'root', profile: { name: 'observed' } }], edges: [{ from: 'root', to: 'child', futureEdge: true }], deliverable: {}, futureObserved: ['retained'] };
const record = { graphDigest: graph.digest, taskDigest: 'task-owned-elsewhere', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z', outcome: { kind: 'delivered', summary: 'fixture' }, cost: { iterations: 1, tokens: 3, usd: 0.1, ms: 2000, inputTokens: 2, outputTokens: 1, humanMessages: 0, leadMessages: 1, mergeMs: 2500 }, traversals: 2, exhaustedEdges: ['0'], taskType: 'investigation', source: { kind: 'fixture', id: 'one', url: 'https://example.invalid/source' }, observedAt: '2026-01-01T00:00:03Z', traceRunId: 'trace', topologyDigest: 'topology-owned-elsewhere', evidence: [{ kind: 'fixture', url: 'https://example.invalid/evidence', at: '2026-01-01T00:00:02Z' }], nodeUsage: [{ nodeId: 'root', sourceId: 'one', startedAt: 'start', lastRecordAt: 'activity', finishedAt: 'end', inputTokens: 2, outputTokens: 1, humanMessages: 0, leadMessages: 1 }], unknowns: ['fixture only'], futureRecord: { retained: true } };
const incomplete = { graphDigest: observed.digest, taskDigest: 'task', startedAt: 'start', outcome: { kind: 'running', reason: 'completion unknown' }, cost: {}, unknowns: ['all usage unknown'] };
const cases = [[GraphNodeSchema, node], [BudgetSchema, budget], [GraphTopologySchema, nested], ...edges.map((edge) => [GraphEdgeSchema, edge]), [StoredGraphSchema, graph], [StoredGraphSchema, observed], [GraphRunRecordSchema, record], [GraphRunRecordSchema, incomplete]];
for (const [schema, input] of cases) {
  const before = canonicalCandidateBytes(input);
  const parsed = schema.parse(input);
  assert.equal(parsed, input);
  assert.deepEqual(canonicalCandidateBytes(parsed), before);
}
assert.equal(StoredGraphSchema.parse(graph).nodes[0].profile, profile);
for (const key of ['budget', 'finishedAt', 'traversals']) assert.equal(Object.hasOwn(key === 'budget' ? observed : incomplete, key), false);
for (const key of ['tokens', 'usd', 'inputTokens', 'outputTokens']) assert.equal(Object.hasOwn(incomplete.cost, key), false);
const coordinates = { runId: 'same-id', namespace: ' namespace with spaces ' + 'x'.repeat(10000) };
assert.deepEqual(RuntimeRunCoordinatesSchema.parse(coordinates), coordinates);
for (const invalid of [{ runId: '', namespace: 'n' }, { runId: 'r', namespace: '' }, { runId: 'r' }]) assert.equal(RuntimeRunCoordinatesSchema.safeParse(invalid).success, false);
for (const [schema, invalid] of [[GraphNodeSchema, { id: 'n', profile: { name: 1 } }], [GraphEdgeSchema, { kind: 'maps', from: 'root', graph: { nodes: [node], edges: [{ kind: 'delegates' }] }, join: 'root', pointer: '', directive, maxItems: 1, concurrency: 1, onItemFailure: 'all-or-refuse' }], [StoredGraphSchema, { ...observed, edges: [{ kind: 'delegates', from: 'root', to: 'child' }] }], [GraphRunRecordSchema, { ...incomplete, outcome: { kind: 'unknown' } }]]) assert.equal(schema.safeParse(invalid).success, false);
const rows = [graph, observed, record, incomplete];
const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const file = join(directory, 'portable-graph.jsonl');
await writeFile(file, jsonl, { flag: 'wx' });
const bytes = await readFile(file);
assert.equal(bytes.toString(), jsonl);
const reread = bytes.toString().trimEnd().split('\n').map((line) => JSON.parse(line));
for (let i = 0; i < reread.length; i++) {
  const schema = i < 2 ? StoredGraphSchema : GraphRunRecordSchema;
  assert.deepEqual(canonicalCandidateBytes(schema.parse(reread[i])), canonicalCandidateBytes(rows[i]));
}
console.log('PORTABLE_GRAPH_PACKED_FILE_PASS=' + JSON.stringify({ cases: cases.length, jsonlFile: file, bytes: bytes.length, rawCanonicalBytesPreserved: true, unknownsOmitted: true, runtimeAlgorithmsNotExercised: true }));
