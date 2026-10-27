// Give a package a breaking release (a minor for 0.x, a major from 1.0) when a workspace
// package it exposes ships one; run before `changeset version`. Changesets would give it a
// patch, so a consumer's caret takes the new dependency major unasked (agent-core 0.10.3
// moved to agent-interface ^3 under consumers on ^2). Exposed: a peer, or a dependency the
// built declarations import. An implementation-only dependency keeps Changesets' patch.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = join(root, ".changeset");
const outputName = "breaking-dependents.md";
const order = { none: 0, patch: 1, minor: 2, major: 3 };

const packages = new Map();
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  const manifestPath = join(root, "packages", entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.private) packages.set(manifest.name, { ...manifest, dir: join(root, "packages", entry.name) });
}

const declarations = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? declarations(join(dir, entry.name)) : /\.d\.[cm]?ts$/.test(entry.name) ? [join(dir, entry.name)] : []);
// Whether the dependent's built declarations import the dependency, so its consumers compile against it.
const exposes = (manifest, dependency) => {
  if (!existsSync(join(manifest.dir, "dist"))) throw new Error(`${manifest.name} has no dist; run pnpm -r build first`);
  const specifier = new RegExp(`(?:from|import\\()\\s*["']${dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^"']*)?["']`);
  return declarations(join(manifest.dir, "dist")).some((file) => specifier.test(readFileSync(file, "utf8")));
};

// Highest pending bump per package, from every changeset except this script's own.
const planned = new Map();
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith(".md") || file === "README.md" || file === outputName) continue;
  const frontmatter = readFileSync(join(changesetDir, file), "utf8").match(/^---\n([\s\S]*?)\n---/);
  for (const line of (frontmatter?.[1] ?? "").split("\n")) {
    const release = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch|none)\s*$/);
    if (!release) continue;
    const [, name, type] = release;
    if (order[type] > order[planned.get(name) ?? "none"]) planned.set(name, type);
  }
}

// The release that is breaking for this package's own consumers.
const isZero = (name) => packages.get(name)?.version.startsWith("0.") ?? false;
const breakingType = (name) => (isZero(name) ? "minor" : "major");
// A major on a 0.x package is its 1.0 graduation, the same API, so dependents keep
// Changesets' patch onto ^1.0.0.
const isBreaking = (name) => (planned.get(name) ?? "none") === breakingType(name);

// A raised dependent is itself breaking for its own dependents.
const raised = new Map();
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, manifest] of packages) {
    if (order[planned.get(name) ?? "none"] >= order[breakingType(name)]) continue;
    const peers = Object.keys(manifest.peerDependencies ?? {});
    const causes = [...peers, ...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })].filter(
      (dependency) => packages.has(dependency) && isBreaking(dependency) && (peers.includes(dependency) || exposes(manifest, dependency)),
    );
    if (causes.length === 0) continue;
    planned.set(name, breakingType(name));
    raised.set(name, [...new Set(causes)].sort());
    changed = true;
  }
}

if (raised.size === 0) process.exit(0);
const names = [...raised.keys()].sort();
const causeList = (name) => raised.get(name).map((cause) => `\`${cause}\``).join(", ");
const body = names.map((name) => `- \`${name}\` exposes the breaking release of ${causeList(name)}.`).join("\n");
writeFileSync(
  join(changesetDir, outputName),
  `---\n${names.map((name) => `"${name}": ${breakingType(name)}`).join("\n")}\n---\n\n` +
    "Move to the new breaking release of a dependency. This release is outside consumers' caret ranges, so they stay on the previous line until they move.\n\n" +
    `${body}\n`,
);
console.log(`raised to a breaking release: ${names.join(", ")}`);
