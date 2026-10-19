export type HarnessContentOmission = "harness-install" | "harness-cache";

/**
 * Codex caches under its home that it downloads again on start: plugin template assets and
 * the remote plugin and apps catalogs. Session state (`.codex/sessions`, the thread sqlite,
 * config) stays. One canary's capture was 84% these directories (186.8 MB of evidence).
 */
const HARNESS_CACHE_DIRECTORIES = [".codex/plugins/cache/", ".codex/cache/remote_plugin_catalog/", ".codex/cache/codex_apps_tools/"];

/** Installed harness packages under a session home, as concrete directories. */
const HARNESS_INSTALL_DIRECTORIES = [".config/opencode/node_modules/"];

/** Why a native file keeps only its metadata, or undefined when its bytes are session state. */
export function harnessContentOmission(rootScope: string, path: string): HarnessContentOmission | undefined {
  // A harness's installed packages, e.g. `.config/opencode/node_modules`.
  if (path.split("/").includes("node_modules")) return "harness-install";
  if (rootScope === "session-home" && HARNESS_CACHE_DIRECTORIES.some((directory) => path.startsWith(directory))) return "harness-cache";
  return undefined;
}

/**
 * Session-home directories whose bytes the Sidecar leaves on the box (`exportRawEvidence`
 * `omitContent`). Derived from the rules above, never written separately: every file the Sidecar
 * omits must be one this capture would keep as metadata anyway, and a prefix that covered the
 * native session store would be refused by the Sidecar (400). Each copy of a codex HOME was about
 * 99 MB and 4-6 s with these bytes, 4.4 MB and under 0.6 s without them (2026-10-19, Beelink).
 */
export const NATIVE_OMIT_CONTENT_DIRECTORIES: readonly string[] = [...HARNESS_CACHE_DIRECTORIES, ...HARNESS_INSTALL_DIRECTORIES];
for (const directory of NATIVE_OMIT_CONTENT_DIRECTORIES) {
  if (!directory.endsWith("/") || harnessContentOmission("session-home", directory + "file") === undefined) {
    throw new Error(`Tangle evidence would omit ${directory} without keeping its files as metadata`);
  }
}
