import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentProviderError } from "@tangle-network/agent-interface/environment-provider";
import type { BridgeSandbox, BridgeSandboxVendor } from "../src/sandbox/index.js";

/**
 * A real vendor for the live proof: each sandbox is a Docker container started
 * from the box image on the local host. It is the same glue a cloud adapter
 * writes: create, exec, spawn, read, write, endpoint, status, destroy, list.
 */
const LABEL = "tbox";
const META = "tbox.meta.";

function docker(args: string[], input?: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", args, { maxBuffer: 64 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code === "ABORT_ERR") return reject(error);
      resolve({ code: typeof (error as { code?: unknown } | null)?.code === "number" ? ((error as unknown as { code: number }).code) : error ? 1 : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function envFile(values: Record<string, string>): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "tbox-env-"));
  const path = join(dir, "env");
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function sandbox(name: string): BridgeSandbox {
  const killMarked = (marker: string): Promise<unknown> =>
    docker(["exec", name, "sh", "-c", `for p in /proc/[0-9]*; do grep -qz 'TBOX_EXEC=${marker}' "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`]);
  return {
    id: name,
    async exec(command, options) {
      const marker = randomBytes(6).toString("hex");
      const wrapped = `export TBOX_EXEC=${marker}; ${command}`;
      const args = ["exec", "-i", ...(options?.cwd ? ["-w", options.cwd] : []), ...Object.entries(options?.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]), name, "sh", "-c", wrapped];
      return new Promise((resolve, reject) => {
        const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let ended = false;
        let reason: Error | undefined;
        const finish = (outcome: () => void): void => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          options?.signal?.removeEventListener("abort", onAbort);
          outcome();
        };
        const end = (why: Error): void => {
          reason ??= why;
          void killMarked(marker).then(() => {
            child.kill("SIGKILL");
            finish(() => reject(reason));
          });
        };
        const onAbort = (): void => end(new DOMException("exec aborted", "AbortError"));
        const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => end(new EnvironmentProviderError("timeout", `exec exceeded ${options.timeoutMs} ms`)), options.timeoutMs);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        if (options?.signal?.aborted) onAbort();
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => finish(() => (reason === undefined ? resolve({ exitCode: code ?? 1, stdout, stderr }) : reject(reason))));
      });
    },
    async spawn(command, options) {
      const file = envFile(options.env);
      try {
        const result = await docker(["exec", "-d", ...(options.cwd ? ["-w", options.cwd] : []), "--env-file", file.path, name, "sh", "-c", `exec ${command} >/tmp/bridge.log 2>&1`]);
        if (result.code !== 0) throw new EnvironmentProviderError("provision_failed", `spawn failed: ${result.stderr.trim()}`);
      } finally {
        file.remove();
      }
    },
    async read(path, options) {
      const result = await docker(["exec", name, "cat", "--", path], undefined, options?.signal);
      if (result.code !== 0) throw new EnvironmentProviderError("not_found", `cannot read ${path}: ${result.stderr.trim()}`);
      return result.stdout;
    },
    async write(path, content, options) {
      const result = await docker(["exec", "-i", name, "sh", "-c", `mkdir -p "$(dirname -- "$1")" && cat > "$1"`, "_", path], content, options?.signal);
      if (result.code !== 0) throw new EnvironmentProviderError("transport", `cannot write ${path}: ${result.stderr.trim()}`);
    },
    async endpoint(port) {
      const result = await docker(["port", name, `${port}/tcp`]);
      const mapping = result.stdout.trim().split("\n")[0]?.replace("0.0.0.0", "127.0.0.1");
      if (result.code !== 0 || !mapping) throw new EnvironmentProviderError("transport", `no published port ${port}: ${result.stderr.trim()}`);
      return { url: `http://${mapping}` };
    },
    async status() {
      const result = await docker(["inspect", "-f", "{{.State.Status}}", name]);
      if (result.code !== 0) return "expired";
      return result.stdout.trim() === "running" ? "running" : "stopped";
    },
    async destroy() {
      await docker(["rm", "-f", name]);
    },
  };
}

export function dockerBoxVendor(image: string): BridgeSandboxVendor {
  return {
    name: "docker-box",
    support: { environment: false, image: false, resources: false, egress: [] },
    async create(request) {
      request.signal?.throwIfAborted();
      const name = `tbox-${randomBytes(5).toString("hex")}`;
      const labels = Object.entries(request.metadata).flatMap(([key, value]) => ["--label", `${META}${key}=${value}`]);
      const file = envFile(request.env);
      try {
        const result = await docker(["run", "-d", "--name", name, "--label", `${LABEL}=1`, "--label", `tbox.name=${request.name ?? ""}`, ...labels, "--env-file", file.path, "-p", "127.0.0.1::3344", image, "sleep", String(Math.ceil(request.lifetimeMs / 1000))], undefined, request.signal);
        if (result.code !== 0) throw new EnvironmentProviderError("provision_failed", `docker run failed: ${result.stderr.trim()}`);
      } finally {
        file.remove();
      }
      return sandbox(name);
    },
    async connect(id) {
      const result = await docker(["inspect", "-f", "{{.Name}}", id]);
      return result.code === 0 ? sandbox(id) : null;
    },
    async list(query) {
      const filters = Object.entries(query.metadata ?? {}).flatMap(([key, value]) => ["--filter", `label=${META}${key}=${value}`]);
      const result = await docker(["ps", "-a", "--filter", `label=${LABEL}=1`, ...filters, "--format", "{{json .}}"]);
      const rows = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { Names: string; State: string; Labels: string });
      return rows.map((row) => {
        const labels = Object.fromEntries(row.Labels.split(",").map((pair) => { const at = pair.indexOf("="); return [pair.slice(0, at), pair.slice(at + 1)]; }));
        const metadata = Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith(META)).map(([key, value]) => [key.slice(META.length), value]));
        const entry = { id: row.Names, status: row.State === "running" ? ("running" as const) : ("stopped" as const), metadata };
        return labels["tbox.name"] ? { ...entry, name: labels["tbox.name"] } : entry;
      }).filter((entry) => query.name === undefined || entry.name === query.name);
    },
  };
}
