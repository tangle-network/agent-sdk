// Keep TRACE_CONTRACT_VERSION equal to the contract's npm version.
// `changeset version` bumps package.json; this rewrites the constant in the same step.
// `--check` fails instead of writing, for CI.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages/agent-trace-contract");
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const spanPath = join(pkgDir, "src/span.ts");
const source = readFileSync(spanPath, "utf8");
const pattern = /export const TRACE_CONTRACT_VERSION = "([^"]+)";/;
const current = source.match(pattern)?.[1];
if (current === undefined) throw new Error(`TRACE_CONTRACT_VERSION not found in ${spanPath}`);
if (current === version) process.exit(0);
if (process.argv.includes("--check")) {
  console.error(`TRACE_CONTRACT_VERSION is ${current} but package.json is ${version}; run node scripts/sync-trace-contract-version.mjs`);
  process.exit(1);
}
writeFileSync(spanPath, source.replace(pattern, `export const TRACE_CONTRACT_VERSION = "${version}";`));
console.log(`TRACE_CONTRACT_VERSION ${current} -> ${version}`);
