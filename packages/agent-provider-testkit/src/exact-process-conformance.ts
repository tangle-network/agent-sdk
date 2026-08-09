import { AgentEnvironmentCapabilitiesSchema } from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentExactProcessEnvironment,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  ExactProcessProviderLifecycleOptions,
  ExactProcessProviderLifecycleReport,
} from "./conformance-types.js";
import {
  abortable,
  bytesEqual,
  terminationEqual,
} from "./exact-process-helpers.js";
import { assert, collect } from "./conformance-helpers.js";

/** Check exact launch, output, recovery, lookup, and deletion behavior. */
export async function runAgentExactProcessProviderLifecycleChecks(
  options: ExactProcessProviderLifecycleOptions,
): Promise<ExactProcessProviderLifecycleReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(provider.exactProcess, "provider.exactProcess is required", checked);
  assert(capabilities.exactProcess, "capabilities.exactProcess is required", checked);
  assert(
    capabilities.exactProcess.egress.includes(options.createInput.egress.mode),
    `provider does not declare ${options.createInput.egress.mode} egress support`,
    checked,
  );
  checked.push("exact-process-capability");

  const operation = new AbortController();
  const timeout = setTimeout(
    () => operation.abort(new Error("exact process lifecycle check timed out")),
    options.timeoutMs ?? 30_000,
  );
  const signal = options.createInput.signal
    ? AbortSignal.any([options.createInput.signal, operation.signal])
    : operation.signal;
  let environment: AgentExactProcessEnvironment;
  try {
    environment = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  let destroyAttempted = false;
  try {
    const repeated = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
    assert(
      repeated.id === environment.id,
      "repeated exact create must recover the same environment",
      checked,
    );
    checked.push("exact-process-idempotency");

    let collisionRejected = false;
    let collisionEnvironment: AgentExactProcessEnvironment | undefined;
    try {
      collisionEnvironment = await abortable(
        provider.exactProcess.create({
          ...options.createInput,
          maxLifetimeMs: options.createInput.maxLifetimeMs + 1_000,
          signal,
        }),
        signal,
      );
    } catch {
      collisionRejected = true;
    } finally {
      if (
        collisionEnvironment?.id &&
        collisionEnvironment.id !== environment.id
      ) {
        await abortable(
          collisionEnvironment.destroy(),
          signal,
        );
      }
    }
    assert(
      collisionRejected,
      "reusing an exact idempotency key with different input must fail",
      checked,
    );
    checked.push("exact-process-idempotency-collision");

    assert((await environment.process.list()).length === 0, "exact environment must start empty", checked);
    checked.push("fresh-environment");

    const expectedFile = Uint8Array.of(0, 1, 2, 255);
    await environment.writeFile("/tmp/agent-provider-testkit.bin", expectedFile, {
      mode: 0o640,
      signal,
    });
    const actualFile = await environment.readFile(
      "/tmp/agent-provider-testkit.bin",
      { maxBytes: expectedFile.byteLength, signal },
    );
    assert(
      bytesEqual(actualFile, expectedFile),
      "exact file read must return the bytes that were written",
      checked,
    );
    let boundedReadRejected = false;
    try {
      await environment.readFile("/tmp/agent-provider-testkit.bin", {
        maxBytes: expectedFile.byteLength - 1,
        signal,
      });
    } catch {
      boundedReadRejected = true;
    }
    assert(
      boundedReadRejected,
      "exact file read must reject content above maxBytes",
      checked,
    );
    checked.push("exact-file-roundtrip");

    const process = await environment.process.spawn(options.launch, {
      signal,
    });
    assert(
      (await environment.process.list()).some((entry) => entry.pid === process.pid),
      "spawned exact process must appear in process.list()",
      checked,
    );
    const stdout = (await collect(process.stdout())).join("");
    const stderr = (await collect(process.stderr())).join("");
    const termination = await abortable(process.wait(), signal);
    const status = await process.status();
    assert(!status.running, "exact process must reach a terminal status", checked);
    assert(status.termination, "terminal exact process status requires a reason", checked);
    assert(
      terminationEqual(status.termination, termination),
      "wait() and status() termination reasons must match",
      checked,
    );
    assert(stdout === options.expectedStdout, "exact process stdout differs", checked);
    assert(stderr === options.expectedStderr, "exact process stderr differs", checked);
    await process.kill();
    checked.push("exact-process-run");

    const recovered = await provider.exactProcess.get(environment.id);
    assert(recovered, "exact environment must be recoverable by id", checked);
    const recoveredProcess = await recovered.process.get(process.pid);
    assert(recoveredProcess, "exact process must be recoverable by pid", checked);
    assert(
      (await collect(recoveredProcess.stdout())).join("") === options.expectedStdout,
      "recovered exact process stdout differs",
      checked,
    );
    assert(
      (await collect(recoveredProcess.stderr())).join("") === options.expectedStderr,
      "recovered exact process stderr differs",
      checked,
    );
    checked.push("exact-process-recovery");

    const listed = await provider.exactProcess.list({ metadata: options.createInput.metadata });
    assert(
      listed.filter((candidate) => candidate.id === environment.id).length === 1,
      "exact environment metadata lookup must return one matching id",
      checked,
    );
    checked.push("exact-process-list");

    destroyAttempted = true;
    await abortable(environment.destroy(), signal);
    assert(
      (await provider.exactProcess.get(environment.id)) === null,
      "destroyed exact environment must not be recoverable",
      checked,
    );
    assert(
      !(await provider.exactProcess.list({
        metadata: options.createInput.metadata,
      })).some((candidate) => candidate.id === environment.id),
      "destroyed exact environment must disappear from list()",
      checked,
    );
    checked.push("exact-process-destroy");

    return {
      provider: provider.name,
      environmentId: environment.id,
      pid: process.pid,
      checked,
    };
  } finally {
    clearTimeout(timeout);
    if (!destroyAttempted) await environment.destroy();
  }
}
