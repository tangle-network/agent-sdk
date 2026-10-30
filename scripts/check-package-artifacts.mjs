import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Range, SemVer, satisfies } from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function run(command, args, options = {}) {
  const result = runProcess(command, args, options);
  const failure = [`${command} ${args.join(" ")} exited ${result.status}`, result.stdout.trim(), result.stderr.trim()];
  if (result.status !== 0) throw new Error(failure.filter(Boolean).join("\n"));
  return result.stdout.trim();
}

// agent-runtime's release admission, at a reviewed revision, on each exact tarball: it refuses a
// major that names no incompatibility and a release on a superseded line.
const ADMIT = `set -e; git init -q; git fetch -q --depth=1 https://github.com/tangle-network/agent-runtime.git 7f5928447fb1cc89b23fd34b16494639d61223a5
git checkout -q FETCH_HEAD -- scripts; npm install -s --no-save --no-package-lock oxc-parser@0.155.0
for tarball; do node scripts/check-version-bump.mjs --archive "$tarball"; done`;

// Verify record-key semantics through the installed package, not workspace aliases.
function assertInstalledProfileRecordKeys(consumerDirectory) {
  run(node, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import {
  applyAgentProfileDiff,
  canonicalAgentProfileDigest,
  diffAgentProfiles,
} from "@tangle-network/agent-interface";
import { mergeAgentProfiles } from "@tangle-network/agent-interface/profile";
import { agentProfileSchema } from "@tangle-network/agent-interface/profile-schema";

for (const key of ["__proto__", "constructor", "prototype", "owner"]) {
  const metadata = JSON.parse(JSON.stringify({ [key]: { x: 1 } }));
  const base = agentProfileSchema.parse({ metadata, resources: { instructions: "base" } });
  const candidate = agentProfileSchema.parse({ metadata, resources: { instructions: "x" } });
  const before = JSON.stringify({ base, candidate });
  const applied = diffAgentProfiles(base, candidate).reduce(applyAgentProfileDiff, base);
  assert.equal(Object.hasOwn(applied.metadata, key), true);
  assert.equal(Object.getPrototypeOf(applied.metadata), Object.prototype);
  assert.equal(canonicalAgentProfileDigest(applied), canonicalAgentProfileDigest(candidate));
  assert.equal(JSON.stringify({ base, candidate }), before);

  const merged = mergeAgentProfiles(base, { metadata: { [key]: { x: 2 } } });
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged.metadata, key), {
    value: { x: 2 }, enumerable: true, configurable: true, writable: true,
  });
  assert.equal(Object.getPrototypeOf(merged.metadata), Object.prototype);
  const unspecified = mergeAgentProfiles(base, { metadata: { [key]: undefined } });
  assert.deepEqual(unspecified.metadata[key], { x: 1 });
  assert.equal(Object.hasOwn(mergeAgentProfiles(undefined, { metadata: { [key]: undefined } }).metadata, key), false);
}
`], { cwd: consumerDirectory });
}

function assertInstalledSeatSpecs(consumerDirectory) {
  run(node, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { agentProfileSchema, canonicalAgentProfileDigest, parseSeatSpec, formatSeatSpec, SeatSpecError } from "@tangle-network/agent-interface";
import * as capabilities from "@tangle-network/agent-interface/harness-capabilities";

assert.equal(parseSeatSpec, capabilities.parseSeatSpec);
assert.equal(formatSeatSpec, capabilities.formatSeatSpec);
for (const [input, harness, model, provider, effort] of [
  ["codex/gpt-6.1-sol@xhigh", "codex", "gpt-6.1-sol", "openai", "xhigh"],
  ["claude/anthropic/claude-sonnet-5-5@low", "claude-code", "anthropic/claude-sonnet-5-5", "anthropic", "low"],
  ["kimi/moonshot/kimi-k2.6@none", "kimi-code", "moonshot/kimi-k2.6", "moonshot", "none"],
  ["opencode/acme/namespace/custom-model", "opencode", "acme/namespace/custom-model", "acme", undefined],
  ["codex/local-custom", "codex", "local-custom", null, undefined],
]) {
  const expected = { harness, model, provider, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
  const parsed = parseSeatSpec(input);
  assert.deepEqual(parsed, expected);
  assert.equal(Object.hasOwn(parsed, "reasoningEffort"), effort !== undefined);
  assert.deepEqual(parseSeatSpec(formatSeatSpec(parsed)), parsed);
}
for (const input of ["", "codex/", "codex//model", "codex/openai/", "opencode/custom//model", "opencode/custom/", "codex/model@", "codex/model@high@low", " codex/model", "codex/a b", "codex/a" + String.fromCharCode(0), "codex/model@invented"]) {
  assert.throws(() => parseSeatSpec(input), (error) => error instanceof SeatSpecError && error.code === "SEAT_SYNTAX");
}
assert.throws(() => parseSeatSpec("invented/model"), { code: "UNKNOWN_HARNESS" });
assert.throws(() => formatSeatSpec({ harness: "codex", model: "openai/" }), { code: "SEAT_SYNTAX" });
assert.throws(() => parseSeatSpec("claude/model@none"), { code: "SEAT_EFFORT_UNSUPPORTED" });
assert.throws(() => parseSeatSpec("kimi/moonshot/kimi-k2.6@xhigh"), { code: "SEAT_EFFORT_UNSUPPORTED" });
assert.throws(() => parseSeatSpec("kimi/openai/gpt-6.1-sol"), { code: "MODEL_PROVIDER_MISMATCH" });

const first = { harness: "codex", provider: "openai", model: "openai/gpt-6.1-sol", selector: { kind: "all-eligible" } };
const base = { harness: first.harness, model: { provider: first.provider, default: first.model }, seats: [first] };
const decoded = agentProfileSchema.parse(base);
assert.deepEqual(decoded, base);
assert.equal(Object.hasOwn(decoded.seats[0], "reasoningEffort"), false);
assert.equal(canonicalAgentProfileDigest(decoded), canonicalAgentProfileDigest(base));
const profiled = { ...base, model: { ...base.model, reasoningEffort: "xhigh" } };
const fallback = { harness: "kimi-code", provider: "moonshot", model: "moonshot/kimi-k2.6", selector: { kind: "all-eligible" } };
assert.equal(agentProfileSchema.safeParse({ ...profiled, seats: [first, fallback] }).success, false);
const explicit = { ...profiled, seats: [first, { ...fallback, reasoningEffort: "none" }] };
assert.deepEqual(agentProfileSchema.parse(explicit), explicit);
assert.equal(agentProfileSchema.safeParse({ ...profiled, seats: [{ ...first, reasoningEffort: "none" }] }).success, false);
assert.equal(agentProfileSchema.safeParse({ ...base, seats: [{ ...first, reasoningEffort: "none" }] }).success, false);
assert.equal(agentProfileSchema.safeParse({ ...profiled, seats: [{ ...first, reasoningEffort: "xhigh" }] }).success, true);
const pi = { ...fallback, harness: "pi", provider: "anthropic", model: "anthropic/claude-sonnet-5-5" };
assert.equal(agentProfileSchema.safeParse({ ...profiled, seats: [first, { ...pi, reasoningEffort: "none" }] }).success, true);
assert.equal(agentProfileSchema.safeParse({ ...profiled, seats: [first, { ...pi, reasoningEffort: "high" }] }).success, false);
console.log("Packed public Interface: canonical seat grammar, stage effort and omitted-field identity passed.");
`], { cwd: consumerDirectory });
}

function optionalPeerNames(manifest, packagesByName) {
  return Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) =>
      manifest.peerDependenciesMeta?.[name]?.optional === true &&
      !packagesByName.has(name),
  );
}

function importFailureReport(result) {
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value)) return value;
    } catch {
      // Keep looking past runtime warnings to the structured failure report.
    }
  }
  return undefined;
}

function importExports(consumerDirectory, specifiers, optionalPeers) {
  const script = `
const failures = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
  try {
    await import(specifier);
  } catch (error) {
    failures.push({
      specifier,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
    });
  }
}
if (failures.length > 0) {
  console.error(JSON.stringify(failures));
  process.exit(1);
}
`;
  const result = runProcess(
    node,
    ["--input-type=module", "--eval", script],
    { cwd: consumerDirectory },
  );
  if (result.status === 0) return [];

  const failures = importFailureReport(result);
  if (!failures) {
    throw new Error(
      [
        `failed to import exports in ${consumerDirectory}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const deferred = [];
  for (const failure of failures) {
    const peer = optionalPeers.find(
      (name) =>
        failure.code === "ERR_MODULE_NOT_FOUND" &&
        (failure.message.includes(`'${name}'`) ||
          failure.message.includes(`"${name}"`)),
    );
    if (!peer) {
      throw new Error(
        `${failure.specifier} failed to import (${failure.code ?? "unknown"}): ${failure.message}`,
      );
    }
    deferred.push({ specifier: failure.specifier, peer });
  }
  return deferred;
}

function assertExactProfileDiffs(consumerDirectory) {
  run(node, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import {
  agentProfileDiffSchema,
  applyAgentProfileDiff,
  canonicalAgentProfileDigest,
  diffAgentProfiles,
} from "@tangle-network/agent-interface";

const axes = ["knowledge", "files", "tools", "skills", "agents", "commands"];
const skill = { kind: "inline", name: "verify", content: "Verify." };
const external = { kind: "github", repository: "example/repo", path: "AGENTS.md", ref: "main" };
const pin = { sourceId: "source_1", generation: "kg_" + "a".repeat(64) };
for (const emptyAxis of axes) {
  const changedAxis = emptyAxis === "skills" ? "knowledge" : "skills";
  const value = changedAxis === "knowledge" ? [pin] : [skill];
  const baseline = { resources: { [emptyAxis]: [] } };
  const candidate = { resources: { [emptyAxis]: [], [changedAxis]: value } };
  for (const [before, after] of [[baseline, candidate], [candidate, baseline]]) {
    const original = structuredClone([before, after]);
    const diffs = diffAgentProfiles(before, after).map((diff) => agentProfileDiffSchema.parse(diff));
    assert.deepEqual(diffs[0].remove.resources, { [changedAxis]: true });
    assert.deepEqual(diffs[1].set.resources[emptyAxis], []);
    const applied = diffs.reduce(applyAgentProfileDiff, before);
    assert.equal(canonicalAgentProfileDigest(applied), canonicalAgentProfileDigest(after));
    diffs[1].set.resources[emptyAxis].push("detachment probe");
    assert.deepEqual([before, after], original);
  }
}
const profiles = [{}, { resources: {} }, { resources: { files: [] } }];
for (const knowledge of [undefined, [], [pin], [{ ...pin, generation: "kg_" + "b".repeat(64) }]]) {
  for (const skills of [undefined, [], [skill]]) {
    profiles.push({ resources: {
      files: [], agents: [external],
      ...(knowledge === undefined ? {} : { knowledge }),
      ...(skills === undefined ? {} : { skills }),
    } });
  }
}
for (const baseline of profiles) {
  for (const candidate of profiles) {
    const diffs = diffAgentProfiles(baseline, candidate).map((diff) => agentProfileDiffSchema.parse(diff));
    assert.equal(canonicalAgentProfileDigest(diffs.reduce(applyAgentProfileDiff, baseline)),
      canonicalAgentProfileDigest(candidate));
    if (baseline.resources?.agents && candidate.resources?.agents) {
      assert.ok(diffs.every((diff) => diff.set?.resources?.agents === undefined));
    }
  }
}
console.log("Packed public Interface: exact resource round trips passed.");
`], { cwd: consumerDirectory });
}

function assertInstalledProxySecrets(consumerDirectory) {
  run(node, [join(root, "scripts/fixtures/proxy-secret-scope-admission.mjs"), consumerDirectory]);
}

function runJson(command, args, options) {
  const output = run(command, args, options);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${command} did not return JSON:\n${output}`,
      { cause: error },
    );
  }
}

function publishablePackages() {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(packagesRoot, entry.name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) return undefined;
      return { directory, manifestPath, manifest: readJson(manifestPath) };
    })
    .filter((entry) => entry !== undefined && entry.manifest.private !== true)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function exportEntries(exportsField) {
  if (exportsField === undefined) return [];
  if (
    typeof exportsField !== "object" ||
    exportsField === null ||
    Array.isArray(exportsField) ||
    !Object.keys(exportsField).some((key) => key.startsWith("."))
  ) {
    return [[".", exportsField]];
  }
  return Object.entries(exportsField);
}

function exportTargets(value, targets = new Set()) {
  if (typeof value === "string") {
    targets.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) exportTargets(item, targets);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) exportTargets(item, targets);
  }
  return targets;
}

function targetPath(packageDirectory, target) {
  if (!target.startsWith("./") || target.includes("*")) {
    throw new Error(`unsupported export target ${target}`);
  }
  const path = resolve(packageDirectory, target);
  if (path !== packageDirectory && !path.startsWith(`${packageDirectory}${sep}`)) {
    throw new Error(`export target escapes package: ${target}`);
  }
  return path;
}

function assertInstalledExports(packageDirectory, manifest) {
  const entries = exportEntries(manifest.exports);
  if (entries.length === 0) {
    throw new Error(`${manifest.name} declares no exports`);
  }

  let targetCount = 0;
  const specifiers = [];
  for (const [subpath, definition] of entries) {
    if (subpath !== "." && !subpath.startsWith("./")) {
      throw new Error(`${manifest.name} has invalid export ${subpath}`);
    }
    specifiers.push(
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
    );
    const targets = exportTargets(definition);
    if (targets.size === 0) {
      throw new Error(`${manifest.name} export ${subpath} has no targets`);
    }
    for (const target of targets) {
      targetCount++;
      if (!existsSync(targetPath(packageDirectory, target))) {
        throw new Error(`${manifest.name} export target is missing: ${target}`);
      }
    }
  }

  for (const field of ["main", "types"]) {
    const target = manifest[field];
    if (target && !existsSync(targetPath(packageDirectory, target))) {
      throw new Error(`${manifest.name} ${field} target is missing: ${target}`);
    }
  }
  return { specifiers, targetCount };
}

function assertRepackedExports(manifest, files) {
  const paths = new Set(files.map((file) => file.path));
  for (const [, definition] of exportEntries(manifest.exports)) {
    for (const target of exportTargets(definition)) {
      const packedPath = target.replace(/^\.\//, "");
      if (!paths.has(packedPath)) {
        throw new Error(
          `${manifest.name} repack omitted export target: ${target}`,
        );
      }
    }
  }
}

function installedDirectory(consumerDirectory, packageName) {
  return join(consumerDirectory, "node_modules", ...packageName.split("/"));
}

const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

function internalDependencies(manifest, packagesByName) {
  return runtimeDependencyFields.flatMap((field) =>
    Object.keys(manifest[field] ?? {})
      .filter((name) => packagesByName.has(name))
      .map((name) => ({ field, name })),
  );
}

function internalDependencyClosure(entry, packagesByName) {
  const closure = new Set();
  const pending = internalDependencies(entry.manifest, packagesByName).map(
    ({ name }) => name,
  );
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === entry.manifest.name || closure.has(name)) continue;
    closure.add(name);
    const dependency = packagesByName.get(name);
    if (!dependency) throw new Error(`missing workspace package ${name}`);
    pending.push(
      ...internalDependencies(dependency.manifest, packagesByName).map(
        ({ name: dependencyName }) => dependencyName,
      ),
    );
  }
  return [...closure].sort();
}

function expectedPackedDependencySpecifier(sourceSpecifier, dependency) {
  if (!sourceSpecifier.startsWith("workspace:")) return sourceSpecifier;
  const selector = sourceSpecifier.slice("workspace:".length);
  if (selector === "*") return dependency.manifest.version;
  if (selector === "^" || selector === "~") {
    return `${selector}${dependency.manifest.version}`;
  }
  if (selector.length === 0) {
    throw new Error(`empty workspace dependency for ${dependency.manifest.name}`);
  }
  return selector;
}

function assertInternalDependencyMetadata(source, packed, packagesByName) {
  for (const field of runtimeDependencyFields) {
    const expectedNames = internalDependencies(source, packagesByName)
      .filter((dependency) => dependency.field === field)
      .map((dependency) => dependency.name)
      .sort();
    const actualNames = internalDependencies(packed, packagesByName)
      .filter((dependency) => dependency.field === field)
      .map((dependency) => dependency.name)
      .sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `${source.name} packed ${field} do not match source: expected ${expectedNames.join(", ") || "none"}; received ${actualNames.join(", ") || "none"}`,
      );
    }
    for (const name of expectedNames) {
      const dependency = packagesByName.get(name);
      if (!dependency) throw new Error(`missing workspace package ${name}`);
      const expectedSpecifier = expectedPackedDependencySpecifier(
        source[field][name],
        dependency,
      );
      const actualSpecifier = packed[field][name];
      if (actualSpecifier !== expectedSpecifier) {
        throw new Error(
          `${source.name} packed ${name} as ${actualSpecifier}; expected ${expectedSpecifier}`,
        );
      }
    }
  }
}

const packages = publishablePackages();
if (packages.length === 0) throw new Error("no publishable packages found");
const packagesByName = new Map(
  packages.map((entry) => [entry.manifest.name, entry]),
);

for (const entry of packages) {
  const { name, scripts } = entry.manifest;
  if (!name) throw new Error(`${entry.manifestPath} has no package name`);
  for (const field of runtimeDependencyFields) {
    for (const [dependency, specifier] of Object.entries(
      entry.manifest[field] ?? {},
    )) {
      if (specifier.startsWith("workspace:")) {
        throw new Error(
          `${name} ${field}.${dependency} must use a publishable version, received ${specifier}`,
        );
      }
      const internalDependency = packagesByName.get(dependency);
      if (internalDependency !== undefined && field !== "peerDependencies") {
        // The declared range must admit the version this workspace publishes
        // and must stop at the next major. Equality is not required: a caret
        // range holds one installed copy across additive minors, and an exact
        // pin pulls a second copy into a tree that already holds another.
        // An open range such as ">=0.9.0" is still refused, because it admits
        // a future major whose removals this package has never compiled against.
        const version = internalDependency.manifest.version;
        let parsed;
        try {
          parsed = new SemVer(version);
        } catch {
          throw new Error(`${dependency} has an unreadable version ${version}`);
        }
        // Build the ceiling from the parsed major rather than semver's inc().
        // inc("1.0.0-rc.1", "major") returns "1.0.0", the stable release of the
        // same major, so a prerelease workspace would reject its own caret range.
        const nextMajor = `${parsed.major + 1}.0.0`;
        let range;
        try {
          range = new Range(specifier);
        } catch {
          throw new Error(
            `${name} ${field}.${dependency} must declare a valid range, received ${specifier}`,
          );
        }
        if (!satisfies(version, range)) {
          throw new Error(
            `${name} ${field}.${dependency} must admit workspace version ${version}, received ${specifier}`,
          );
        }
        // Probe every later major, not only the next one. A disjunction such as
        // "^1.0.0 || ^3.0.0" excludes 2.0.0 yet still admits a major this
        // package has never compiled against.
        for (const major of [parsed.major + 1, parsed.major + 2, 999999]) {
          if (satisfies(`${major}.0.0`, range)) {
            throw new Error(
              `${name} ${field}.${dependency} must stop below ${nextMajor}, received ${specifier}`,
            );
          }
        }
      }
    }
  }
  if (scripts?.prepare !== undefined) {
    throw new Error(`${name} must not define the install/repack prepare lifecycle`);
  }
  if (scripts?.prepublishOnly !== "pnpm run build") {
    throw new Error(`${name} must build through prepublishOnly`);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-sdk-artifacts-"));
try {
  const sourceTarballs = join(temporaryRoot, "source");
  const consumersRoot = join(temporaryRoot, "consumers");
  const repackedTarballs = join(temporaryRoot, "repacked");
  const npmCache = join(temporaryRoot, "npm-cache");
  const admission = join(temporaryRoot, "admission");
  for (const directory of [sourceTarballs, consumersRoot, repackedTarballs, admission]) {
    mkdirSync(directory, { recursive: true });
  }

  const tarballs = new Map();
  for (const entry of packages) {
    const packed = runJson(
      pnpm,
      ["pack", "--json", "--pack-destination", sourceTarballs],
      { cwd: entry.directory },
    );
    if (packed.name !== entry.manifest.name || !existsSync(packed.filename)) {
      throw new Error(`failed to pack ${entry.manifest.name}`);
    }
    tarballs.set(entry.manifest.name, packed.filename);
  }
  console.log(run("bash", ["-c", ADMIT, "admit", ...tarballs.values()], { cwd: admission }));

  const npmEnvironment = {
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_ignore_scripts: "false",
    npm_config_update_notifier: "false",
  };
  let exportCount = 0;
  let exportTargetCount = 0;
  for (const entry of packages) {
    const consumerDirectory = join(
      consumersRoot,
      entry.manifest.name.replace(/^@/, "").replaceAll("/", "-"),
    );
    mkdirSync(consumerDirectory, { recursive: true });
    const dependencyNames = [
      entry.manifest.name,
      ...internalDependencyClosure(entry, packagesByName),
    ];
    const dependencies = Object.fromEntries(
      dependencyNames.map((name) => {
        const tarball = tarballs.get(name);
        if (!tarball) throw new Error(`missing tarball for ${name}`);
        return [
          name,
          `file:${relative(consumerDirectory, tarball).split(sep).join("/")}`,
        ];
      }),
    );
    writeFileSync(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "agent-sdk-package-artifact-check",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    run(
      npm,
      ["install", "--package-lock=false", "--ignore-scripts=false"],
      { cwd: consumerDirectory, env: npmEnvironment },
    );

    const directory = installedDirectory(consumerDirectory, entry.manifest.name);
    const manifest = readJson(join(directory, "package.json"));
    if (manifest.name !== entry.manifest.name) {
      throw new Error(`installed the wrong package for ${entry.manifest.name}`);
    }
    if (manifest.scripts?.prepare !== undefined) {
      throw new Error(`${manifest.name} tarball still contains prepare`);
    }
    assertInternalDependencyMetadata(
      entry.manifest,
      manifest,
      packagesByName,
    );
    const exportsCheck = assertInstalledExports(directory, manifest);
    for (const subpath of Object.keys(entry.manifest.exports ?? {})) {
      if (!(subpath in (manifest.exports ?? {}))) {
        throw new Error(
          `${manifest.name} publishes without export ${subpath}; add it to publishConfig.exports`,
        );
      }
    }
    exportCount += exportsCheck.specifiers.length;
    exportTargetCount += exportsCheck.targetCount;
    const optionalPeers = optionalPeerNames(manifest, packagesByName);
    importExports(
      consumerDirectory,
      exportsCheck.specifiers,
      optionalPeers,
    );
    if (manifest.name === "@tangle-network/agent-interface") {
      assertInstalledProfileRecordKeys(consumerDirectory);
      assertInstalledSeatSpecs(consumerDirectory);
    }
    if (optionalPeers.length > 0) {
      run(
        npm,
        [
          "install",
          "--no-save",
          "--package-lock=false",
          "--ignore-scripts=false",
          ...optionalPeers.map(
            (name) => `${name}@${manifest.peerDependencies[name]}`,
          ),
        ],
        { cwd: consumerDirectory, env: npmEnvironment },
      );
      importExports(consumerDirectory, exportsCheck.specifiers, []);
    }

    if (entry.manifest.name === "@tangle-network/agent-interface") {
      assertExactProfileDiffs(consumerDirectory);
      assertInstalledProxySecrets(consumerDirectory);
    }

    const packed = runJson(
      npm,
      [
        "pack",
        directory,
        "--json",
        "--pack-destination",
        repackedTarballs,
        "--ignore-scripts=false",
      ],
      { cwd: consumerDirectory, env: npmEnvironment },
    );
    // npm 10 and 11 print an array of pack results; npm 12 prints an object
    // keyed by package name.
    const result = Array.isArray(packed) ? packed[0] : packed?.[manifest.name];
    if (!result || !existsSync(join(repackedTarballs, result.filename))) {
      throw new Error(`failed to repack ${entry.manifest.name}`);
    }
    assertRepackedExports(manifest, result.files ?? []);
  }

  console.log(
    `Checked ${packages.length} isolated packages, ${exportCount} exports, and ${exportTargetCount} export targets.`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
