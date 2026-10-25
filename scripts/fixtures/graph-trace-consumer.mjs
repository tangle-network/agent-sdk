import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ATTR, contractSpan, validateTraceSpans } from '@tangle-network/agent-trace-contract';
const keys = [ATTR.graphDigest, ATTR.graphNodeId, ATTR.graphTopologyDigest];
assert.deepEqual(keys, ['agent.graph.digest', 'agent.graph.node_id', 'agent.graph.topology_digest']);
const design = { nodes: ['root'], edges: [] };
const digest = (value) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const spans = [contractSpan({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'declared-fixture', kind: 'AGENT', startTime: '2026-01-01T00:00:00Z', attributes: { [keys[0]]: digest(design), [keys[1]]: design.nodes[0], [keys[2]]: digest(design.edges) } }), contractSpan({ traceId: '1'.repeat(32), spanId: '3'.repeat(16), parentSpanId: '2'.repeat(16), name: 'unknown-design', kind: 'CHAIN', startTime: '2026-01-01T00:00:00Z' })];
const dir = process.env.SDK_TRACE_PROOF_DIR;
assert.ok(dir);
try {
  const file = join(dir, 'trace.jsonl');
  await writeFile(file, spans.map((span) => JSON.stringify(span)).join('\n') + '\n');
  const bytes = await readFile(file);
  const decoded = bytes.toString().trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(decoded, spans);
  for (const key of keys) assert.equal(Object.hasOwn(decoded[1].attributes, key), false);
  for (const span of decoded) for (const key of [ATTR.model, ATTR.inputTokens, ATTR.outputTokens, ATTR.costUsd]) assert.equal(Object.hasOwn(span.attributes, key), false);
  const validation = validateTraceSpans(decoded);
  assert.equal(validation.ok, true);
  assert.equal(validation.findings.some((finding) => finding.severity === 'error'), false);
  console.log('SDK568_JSONL_SMOKE=' + JSON.stringify({ spans: decoded, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, validation }));
} catch (error) { console.error('SDK568_FAILURE_TEMP_RETAINED=' + dir); throw error; }
