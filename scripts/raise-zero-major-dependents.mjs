// Give every 0.x package a minor release when a workspace package it depends on
// ships a breaking release. Run before `changeset version`.
//
// Changesets releases a dependent with a patch when a dependency leaves its range.
// For a 0.x dependent a patch stays inside its consumers' `^0.y.z` range, so they
// receive the new dependency major without asking and install two copies of it
// (agent-core 0.10.3 moved to agent-interface ^3 under consumers still on ^2).
// A 0.x minor is outside `^0.y.z`, so consumers move when they choose to.
// Changesets has no option for this, so this script writes the changeset instead.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = join(root, ".changeset");
const outputName = "zero-major-dependents.md";
const order = { none: 0, patch: 1, minor: 2, major: 3 };
const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

const packages = new Map();
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  const manifestPath = join(root, "packages", entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) continue;
  packages.set(manifest.name, manifest);
}

// Highest pending bump per package, from every changeset except this script's own.
const planned = new Map();
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith(".md") || file === "README.md" || file === outputName) continue;
  const frontmatter = readFileSync(join(changesetDir, file), "utf8").match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) continue;
  for (const line of frontmatter[1].split("\n")) {
    const release = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch|none)\s*$/);
    if (!release) continue;
    const [, name, type] = release;
    if (order[type] > order[planned.get(name) ?? "none"]) planned.set(name, type);
  }
}

const isZero = (name) => packages.get(name)?.version.startsWith("0.") ?? false;
const isBreaking = (name) => {
  const type = planned.get(name) ?? "none";
  return type === "major" || (type === "minor" && isZero(name));
};

// A raised 0.x dependent is itself breaking for its own 0.x dependents.
const raised = new Map();
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, manifest] of packages) {
    if (!isZero(name) || order[planned.get(name) ?? "none"] >= order.minor) continue;
    const causes = runtimeDependencyFields
      .flatMap((field) => Object.keys(manifest[field] ?? {}))
      .filter((dependency) => packages.has(dependency) && isBreaking(dependency));
    if (causes.length === 0) continue;
    planned.set(name, "minor");
    raised.set(name, [...new Set(causes)].sort());
    changed = true;
  }
}

const outputPath = join(changesetDir, outputName);
if (raised.size === 0) process.exit(0);
const names = [...raised.keys()].sort();
const body = names
  .map((name) => `- \`${name}\` depends on the breaking release of ${raised.get(name).map((cause) => `\`${cause}\``).join(", ")}.`)
  .join("\n");
writeFileSync(
  outputPath,
  `---\n${names.map((name) => `"${name}": minor`).join("\n")}\n---\n\n` +
    "Move to the new breaking release of a dependency. This is a minor release, so `^0.x` consumers stay on the previous line until they move.\n\n" +
    `${body}\n`,
);
console.log(`raised to minor: ${names.join(", ")}`);
