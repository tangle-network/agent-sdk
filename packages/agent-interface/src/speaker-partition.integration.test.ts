/** Install the real archive into a server with no UI peers; replay stored/live parts through its public contract. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("groups an installed transcript without importing a React or UI peer", () => {
  const directory = mkdtempSync(join(tmpdir(), "speaker-package-"));
  const run = (command: string, args: string[], cwd = directory) =>
    execFileSync(command, args, { cwd, encoding: "utf8", timeout: 90_000 });
  try {
    run("pnpm", ["pack", "--pack-destination", directory], resolve("."));
    const archive = readdirSync(directory).find(name => name.endsWith(".tgz"));
    if (!archive) throw new Error("The package archive was not produced");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module",
      dependencies: { "@tangle-network/agent-interface": "file:" + join(directory, archive) } }));
    run("npm", ["install", "--package-lock=false", "--ignore-scripts=false"]);
    writeFileSync(join(directory, "no-ui.mjs"), `
export function resolve(specifier, context, next) {
  if (/^(react(?:-dom)?(?:\\/|$)|@tangle-network\\/(?:ui|sandbox-ui)(?:\\/|$))/.test(specifier)) throw new Error('Server imported a UI peer: ' + specifier);
  return next(specifier, context);
}
`);
    writeFileSync(join(directory, "consumer.mjs"), `
import assert from 'node:assert/strict';
import { partitionBySpeaker } from '@tangle-network/agent-interface/speaker';
import { partitionBySpeaker as rootPartition } from '@tangle-network/agent-interface';
assert.equal(rootPartition, partitionBySpeaker);
const parts = [
  { type: 'text', text: 'Shared.' },
  { type: 'speaker', id: 'writer', name: 'Writer' },
  { type: 'speaker', id: 'research', name: 'Research' },
  { type: 'text', text: 'Headline.', speaker: 'writer' },
  { type: 'file', path: 'brief.md', speaker: 'writer' },
  { type: 'text', text: 'Risks.', speaker: 'research' },
  { type: 'text', text: 'Unannounced.', speaker: 'missing' },
  { type: 'speaker', id: 'writer', name: 'Writer', state: 'done' },
  { type: 'speaker', id: 'research', name: 'Research', state: 'failed' },
];
const before = JSON.stringify(parts);
const sections = partitionBySpeaker(parts);
assert.deepEqual(sections.map(s => [s.speaker?.id ?? null, s.parts.map(p => p.text ?? p.path)]), [
  [null, ['Shared.', 'Unannounced.']], ['writer', ['Headline.', 'brief.md']], ['research', ['Risks.']],
]);
assert.equal(sections[1].speaker, parts[7]);
assert.equal(sections[2].speaker, parts[8]);
assert.equal(sections[1].parts[0], parts[3]);
assert.equal(sections[1].parts[1], parts[4]);
assert.equal(JSON.stringify(parts), before);
const stored = [{ type: 'speaker', id: 'writer', name: 'Writer' }, { type: 'text', text: 'Stored.' }];
assert.equal(partitionBySpeaker(stored)[0].parts[0], stored[1]);
assert.deepEqual(partitionBySpeaker([]), [{ speaker: null, parts: [] }]);
console.log('installed speaker contract PASS: server imports, grouping, final states, references, stored rows');
`);
    expect(run(process.execPath, ["--experimental-loader", "./no-ui.mjs", "./consumer.mjs"]))
      .toContain("installed speaker contract PASS");
    expect(JSON.parse(readFileSync(join(directory, "node_modules/@tangle-network/agent-interface/package.json"), "utf8")).name)
      .toBe("@tangle-network/agent-interface");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
