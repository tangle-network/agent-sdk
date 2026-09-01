import type {
  AgentExactProcess,
  AgentExactProcessEnvironment,
  AgentExactProcessLaunch,
  AgentExactProcessStatus,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxInstanceLike,
  SandboxProcessLike,
} from "./tangle-types.js";
import {
  attachCleanupHandle,
  awaitWithSignal,
  MAX_EXACT_FILE_BYTES,
  MAX_LIST_RESULTS,
} from "./tangle-contract-safety.js";
import {
  exactProcessStatusFromSandbox,
  sandboxProcessAsExactProcess,
  validateExactProcessLaunch,
} from "./tangle-exact-process-runtime.js";
import {
  assertAbsoluteFilePath,
  assertFileOptions,
  assertSignalOptions,
} from "./tangle-exact-process-validation.js";

export function sandboxInstanceAsExactProcessEnvironment(
  box: SandboxInstanceLike,
  providerName: string,
): AgentExactProcessEnvironment {
  if (
    !box.fs ||
    box.fs.supportsWriteMode !== true ||
    !box.process ||
    !box.delete
  ) {
    throw new Error(
      "Tangle sandbox does not expose exact files, processes, and deletion",
    );
  }
  const process = box.process;
  const fs = box.fs;
  const destroy = box.delete.bind(box);
  // The same single delete this environment performs, once it is asked for.
  // See the destroy() below for why one is all the platform accepts.
  let destruction: Promise<void> | undefined;
  return {
    id: box.id,
    provider: providerName,
    ...(box.metadata ? { metadata: box.metadata } : {}),
    process: {
      async list(options = {}): Promise<AgentExactProcessStatus[]> {
        assertSignalOptions(options, "Tangle exact process list");
        options.signal?.throwIfAborted();
        const statuses = await awaitWithSignal(process.list(), options.signal);
        options.signal?.throwIfAborted();
        if (!Array.isArray(statuses) || statuses.length > MAX_LIST_RESULTS) {
          throw new Error("Tangle exact process status list exceeded its result bound");
        }
        return statuses.map(exactProcessStatusFromSandbox);
      },
      async get(pid: number, options = {}): Promise<AgentExactProcess | null> {
        if (!Number.isSafeInteger(pid) || pid < 1) {
          throw new Error("Tangle exact process pid is invalid");
        }
        assertSignalOptions(options, "Tangle exact process get");
        options.signal?.throwIfAborted();
        const handle = await awaitWithSignal(process.get(pid), options.signal);
        options.signal?.throwIfAborted();
        if (!handle || handle.pid !== pid) return null;
        return sandboxProcessAsExactProcess(handle);
      },
      async spawn(
        launch: AgentExactProcessLaunch,
        operation = {},
      ): Promise<AgentExactProcess> {
        assertSignalOptions(operation, "Tangle exact process spawn");
        operation.signal?.throwIfAborted();
        validateExactProcessLaunch(launch);
        let handle: SandboxProcessLike | undefined;
        const spawnPromise = process.spawnExact(launch.executable, launch.args, {
          cwd: launch.cwd,
          env: { ...launch.env },
          inheritEnv: false,
          ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
          timeoutMs: launch.timeoutMs,
          ...(operation.signal ? { signal: operation.signal } : {}),
        });
        try {
          handle = await awaitWithSignal(spawnPromise, operation.signal);
          operation.signal?.throwIfAborted();
          return sandboxProcessAsExactProcess(handle);
        } catch (error) {
          if (!handle && operation.signal?.aborted) {
            void spawnPromise
              .then(async (lateHandle) => {
                try {
                  await lateHandle.kill("SIGKILL", { tree: true });
                } catch (cleanupError) {
                  attachCleanupHandle(error, lateHandle, cleanupError);
                }
              })
              .catch((lateError) => attachCleanupHandle(error, undefined, lateError));
            throw error;
          }
          if (!handle) throw error;
          try {
            await handle.kill("SIGKILL", { tree: true });
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Tangle exact process spawn and cleanup both failed",
            );
          }
          throw error;
        }
      },
    },
    async writeFile(path, bytes, options): Promise<void> {
      assertFileOptions(options, "Tangle exact process write");
      options.signal?.throwIfAborted();
      assertAbsoluteFilePath(path);
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("Tangle exact process write requires Uint8Array bytes");
      }
      if (bytes.byteLength > MAX_EXACT_FILE_BYTES) {
        throw new Error("Tangle exact process write exceeds its byte bound");
      }
      if (
        !Number.isSafeInteger(options.mode) ||
        options.mode < 0 ||
        options.mode > 0o7777
      ) {
        throw new Error(
          "Tangle exact process file mode must be between 0 and 07777",
        );
      }
      await awaitWithSignal(
        fs.write(path, Buffer.from(bytes).toString("base64"), {
          encoding: "base64",
          mode: options.mode,
        }),
        options.signal,
      );
      options.signal?.throwIfAborted();
    },
    async readFile(path, options): Promise<Uint8Array> {
      assertFileOptions(options, "Tangle exact process read");
      options.signal?.throwIfAborted();
      assertAbsoluteFilePath(path);
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
        throw new Error(
          "Tangle exact process maxBytes must be a positive integer",
        );
      }
      if (options.maxBytes > MAX_EXACT_FILE_BYTES) {
        throw new Error("Tangle exact process maxBytes exceeds its bound");
      }
      const stat = await awaitWithSignal(fs.stat(path), options.signal);
      options.signal?.throwIfAborted();
      if (
        !stat ||
        typeof stat !== "object" ||
        typeof stat.isFile !== "boolean" ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > MAX_EXACT_FILE_BYTES
      ) {
        throw new Error("Tangle exact process file stat returned an invalid size");
      }
      if (!stat.isFile) {
        throw new Error("Tangle exact process path is not a regular file");
      }
      if (stat.size > options.maxBytes) {
        throw new Error("Tangle exact process file exceeds maxBytes");
      }
      const result = await awaitWithSignal(
        fs.readBatch([path], { encoding: "base64" }),
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (
        !result ||
        !Array.isArray(result.files) ||
        result.files.length > 1 ||
        !Array.isArray(result.errors) ||
        result.errors.length > 256
      ) {
        throw new Error("Tangle exact process file read returned an invalid result");
      }
      for (const error of result.errors) {
        if (
          !error ||
          typeof error !== "object" ||
          typeof error.path !== "string" ||
          error.path.length > 512 ||
          typeof error.error !== "string" ||
          error.error.length > 16_384 ||
          (error.code !== undefined &&
            (typeof error.code !== "string" || error.code.length > 512))
        ) {
          throw new Error("Tangle exact process file read returned an invalid error");
        }
      }
      const file = result.files[0];
      if (
        result.errors.length !== 0 ||
        result.files.length !== 1 ||
        !file ||
        file.path !== path ||
        file.encoding !== "base64" ||
        typeof file.content !== "string" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_EXACT_FILE_BYTES ||
        file.content.length > Math.ceil((MAX_EXACT_FILE_BYTES / 3) * 4) ||
        file.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
      ) {
        throw new Error(
          result.errors[0]?.error ??
            "Tangle exact process file read returned an invalid result",
        );
      }
      const bytes = Uint8Array.from(Buffer.from(file.content, "base64"));
      if (
        bytes.byteLength !== file.size ||
        bytes.byteLength !== stat.size ||
        bytes.byteLength > options.maxBytes
      ) {
        throw new Error(
          "Tangle exact process file read violated its byte bound",
        );
      }
      return bytes;
    },
    async destroy(options = {}): Promise<void> {
      assertSignalOptions(options, "Tangle exact process destroy");
      options.signal?.throwIfAborted();
      // Deleting one sandbox twice is refused, not repeated: the platform
      // holds a per-sandbox lifecycle lease past the first DELETE's own
      // response while its deferred cleanup runs, so a second DELETE inside
      // that window answers "A sandbox lifecycle operation is already in
      // progress". Measured 2026-09-01 (issue #280) on the streaming
      // environment, which has the same shape and the same platform route.
      // This environment is destroyed once and later callers join that
      // answer; a delete that fails is not remembered, so nothing hides a
      // real error.
      destruction ??= awaitWithSignal(destroy(), options.signal)
        .then(() => undefined)
        .catch((error: unknown) => {
          destruction = undefined;
          throw error;
        });
      await awaitWithSignal(destruction, options.signal);
      options.signal?.throwIfAborted();
    },
  };
}
