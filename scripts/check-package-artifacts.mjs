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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
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
  for (const directory of [sourceTarballs, consumersRoot, repackedTarballs]) {
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
    exportCount += exportsCheck.specifiers.length;
    exportTargetCount += exportsCheck.targetCount;
    run(
      node,
      [
        "--input-type=module",
        "--eval",
        `for (const specifier of ${JSON.stringify(exportsCheck.specifiers)}) { await import(specifier) }`,
      ],
      { cwd: consumerDirectory },
    );

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
    const result = Array.isArray(packed) ? packed[0] : packed;
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
