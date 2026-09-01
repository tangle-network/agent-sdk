import type { CreateSandboxOptions } from "@tangle-network/sandbox";
import type {
  AgentExactProcessEnvironment,
  AgentExactProcessProvider,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  TangleExactProcessOptions,
} from "./tangle-types.js";
import {
  assertBoundedJson,
  attachCleanupHandle,
  awaitWithSignal,
  boundedIdentifier,
  boundedString,
  exactProcessRequestDigest,
  isBoundedJson,
  MAX_LIST_RESULTS,
  SANDBOX_LIST_PAGE_SIZE,
} from "./tangle-contract-safety.js";
import { sandboxInstanceAsExactProcessEnvironment } from "./tangle-exact-process-environment.js";
import { awaitSandboxRunning } from "./tangle-readiness.js";
import {
  assertExactProcessSandbox,
  assertSupportedProviderOptions,
  assertUnreservedMetadata,
  EXACT_PROCESS_METADATA_KEY,
  isExactProcessRequestConflict,
  isExactProcessSandbox,
  metadataMatches,
  assertSignalOptions,
} from "./tangle-exact-process-validation.js";

const IMMUTABLE_TANGLE_IMAGE =
  /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/i;
type TangleExactSandboxOptions = Omit<
  CreateSandboxOptions,
  "agent" | "driver" | "egressPolicy" | "environment"
> & {
  environment: string;
  agent: false;
  driver: { type: "host-agent"; runtimeBackend: "docker" };
  egressPolicy:
    | { mode: "blocked" }
    | {
        mode: "strict";
        allowDomains: string[];
        includeImplicitDomains: false;
      };
};

export function createTangleExactProcessProvider(input: {
  client: SandboxClientLike;
  options: TangleExactProcessOptions;
  providerName: string;
  /** How long create() waits for the new sandbox to reach `running`. */
  readyTimeoutMs: number;
}): AgentExactProcessProvider {
  const { client, options, providerName, readyTimeoutMs } = input;
  boundedIdentifier(providerName, "Tangle exact process provider");
  if (options.teamId !== undefined) {
    boundedIdentifier(options.teamId, "Tangle exact process team id");
  }
  const get = client.get;
  const list = client.list;
  if (!get || !list) {
    throw new Error("Tangle exact process provider requires get() and list()");
  }
  return {
    async create(createInput): Promise<AgentExactProcessEnvironment> {
      createInput.signal?.throwIfAborted();
      assertSupportedProviderOptions(createInput.providerOptions);
      assertUnreservedMetadata(createInput.metadata);
      const identityDigest = exactProcessRequestDigest(createInput, providerName, options);
      createInput.signal?.throwIfAborted();
      const createPromise = client.create(exactSandboxOptions(createInput, options, providerName, identityDigest), {
        ...(createInput.signal ? { signal: createInput.signal } : {}),
        ...(createInput.provisionTimeoutMs === undefined
          ? {}
          : { timeoutMs: createInput.provisionTimeoutMs }),
      });
      let box: SandboxInstanceLike;
      try {
        box = await awaitWithSignal(createPromise, createInput.signal);
      } catch (error) {
        if (createInput.signal?.aborted) {
          void createPromise
            .then(async (lateBox) => {
              if (!lateBox.delete) {
                attachCleanupHandle(error, lateBox);
                return;
              }
              try {
                await lateBox.delete();
              } catch (cleanupError) {
                attachCleanupHandle(error, lateBox, cleanupError);
              }
            })
            .catch((lateError) => attachCleanupHandle(error, undefined, lateError));
        }
        throw error;
      }
      try {
        createInput.signal?.throwIfAborted();
        // A launch starts a process on this sandbox, so create() returns only
        // after the sandbox can run one. See tangle-readiness.ts for the box
        // that proved the race.
        await awaitSandboxRunning(box, client, {
          timeoutMs: readyTimeoutMs,
          ...(createInput.signal ? { signal: createInput.signal } : {}),
        });
        createInput.signal?.throwIfAborted();
        assertExactProcessSandbox(box, providerName, options.teamId, identityDigest);
        return sandboxInstanceAsExactProcessEnvironment(box, providerName);
      } catch (error) {
        if (
          isExactProcessRequestConflict(
            box,
            providerName,
            options.teamId,
            createInput.idempotencyKey,
            identityDigest,
          )
        ) {
          throw new Error(
            "Tangle exact process idempotency key conflicts with an existing request",
            { cause: error },
          );
        }
        if (!box.delete) {
          const baseError = error instanceof Error ? error : new Error(String(error));
          throw Object.assign(baseError, {
            cleanupHandle: box,
            message: `${error instanceof Error ? error.message : String(error)}; provider returned no cleanup handle`,
          });
        }
        try {
          await box.delete();
        } catch (cleanupError) {
          const combined = new AggregateError(
            [error, cleanupError],
            "Tangle exact process validation and cleanup both failed",
          );
          attachCleanupHandle(combined, box, cleanupError);
          throw combined;
        }
        throw error;
      }
    },
    async get(id, operation = {}): Promise<AgentExactProcessEnvironment | null> {
      assertSignalOptions(operation, "Tangle exact process get");
      boundedIdentifier(id, "exact process environment id");
      operation.signal?.throwIfAborted();
      const box = await awaitWithSignal(
        get.call(client, id, operation.signal ? { signal: operation.signal } : undefined),
        operation.signal,
      );
      operation.signal?.throwIfAborted();
      if (
        !box ||
        boundedIdentifier(box.id, "exact process environment id") !== id ||
        (box.metadata !== undefined && !isBoundedJson(box.metadata)) ||
        !isExactProcessSandbox(box, providerName, options.teamId)
      ) return null;
      return sandboxInstanceAsExactProcessEnvironment(box, providerName);
    },
    async list(query, operation = {}): Promise<AgentExactProcessEnvironment[]> {
      assertSignalOptions(operation, "Tangle exact process list");
      query?.signal?.throwIfAborted();
      operation.signal?.throwIfAborted();
      const signal = query?.signal ?? operation.signal;
      assertSupportedProviderOptions(query?.providerOptions);
      assertExactProcessListQuery(query);
      const matches: AgentExactProcessEnvironment[] = [];
      for (let offset = 0; ; offset += SANDBOX_LIST_PAGE_SIZE) {
        if (offset > MAX_LIST_RESULTS) {
          throw new Error("Tangle exact process list exceeded its page bound");
        }
        signal?.throwIfAborted();
        const page = await awaitWithSignal(list.call(client, {
          ...(options.teamId
            ? { scope: `team:${options.teamId}` }
            : { scope: "personal" }),
          limit: SANDBOX_LIST_PAGE_SIZE,
          offset,
          ...(signal ? { signal } : {}),
        }), signal);
        if (!Array.isArray(page) || page.length > SANDBOX_LIST_PAGE_SIZE) {
          throw new Error("Tangle exact process list returned an invalid page size");
        }
        if (offset + page.length > MAX_LIST_RESULTS) {
          throw new Error("Tangle exact process list exceeded its result bound");
        }
        signal?.throwIfAborted();
        for (const box of page) {
          signal?.throwIfAborted();
          boundedIdentifier(box.id, "exact process environment id");
          if (box.metadata !== undefined && !isBoundedJson(box.metadata)) {
            throw new Error("Tangle exact process metadata exceeds its bound");
          }
          if (
            isExactProcessSandbox(box, providerName, options.teamId) &&
            metadataMatches(box.metadata, query?.metadata)
          ) {
            matches.push(
              sandboxInstanceAsExactProcessEnvironment(box, providerName),
            );
            if (matches.length > MAX_LIST_RESULTS) {
              throw new Error("Tangle exact process list exceeded its result bound");
            }
          }
        }
        if (page.length < SANDBOX_LIST_PAGE_SIZE) return matches;
      }
    },
  };
}

function exactSandboxOptions(
  input: CreateAgentExactProcessEnvironmentInput,
  defaults: TangleExactProcessOptions,
  providerName: string,
  identityDigest: `sha256:${string}`,
): TangleExactSandboxOptions {
  boundedString(input.image, "exact process image");
  boundedIdentifier(input.idempotencyKey, "exact process idempotencyKey");
  assertBoundedJson(input.metadata);
  if (!input.image.trim()) throw new Error("exact process image is required");
  if (!IMMUTABLE_TANGLE_IMAGE.test(input.image)) {
    throw new Error(
      "Tangle exact process image must include a sha256 manifest digest",
    );
  }
  if (
    !Number.isSafeInteger(input.maxLifetimeMs) ||
    input.maxLifetimeMs < 1 ||
    input.maxLifetimeMs % 1_000 !== 0
  ) {
    throw new Error(
      "Tangle exact process maxLifetimeMs must be a positive whole number of seconds",
    );
  }
  if (
    input.provisionTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.provisionTimeoutMs) ||
      input.provisionTimeoutMs < 1)
  ) {
    throw new Error(
      "exact process provisionTimeoutMs must be a positive integer",
    );
  }
  if (
    input.egress.mode === "strict" &&
    input.egress.allowDomains.length === 0
  ) {
    throw new Error("strict exact process egress requires at least one domain");
  }
  const resources = sandboxResourcesFromRequest(input.resources);
  return {
    environment: input.image,
    agent: false,
    driver: { type: "host-agent", runtimeBackend: "docker" },
    ephemeral: true,
    sshEnabled: false,
    webTerminalEnabled: false,
    secrets: [],
    capabilities: [],
    egressPolicy:
      input.egress.mode === "blocked"
        ? { mode: "blocked" }
        : {
            mode: "strict",
            allowDomains: [...input.egress.allowDomains],
            includeImplicitDomains: false,
          },
    maxLifetimeSeconds: input.maxLifetimeMs / 1_000,
    idempotencyKey: input.idempotencyKey,
    metadata: {
      ...input.metadata,
      [EXACT_PROCESS_METADATA_KEY]: {
        version: 1,
        provider: providerName,
        ...(defaults.teamId ? { teamId: defaults.teamId } : {}),
        idempotencyKey: input.idempotencyKey,
        requestDigest: identityDigest,
      },
    },
    ...(defaults.teamId ? { teamId: defaults.teamId } : {}),
    resources,
  };
}

function sandboxResourcesFromRequest(
  requested: CreateAgentExactProcessEnvironmentInput["resources"],
): NonNullable<CreateSandboxOptions["resources"]> {
  if (!Number.isFinite(requested.cpu) || requested.cpu <= 0) {
    throw new Error("Tangle exact process CPU must be positive and finite");
  }
  if (!Number.isSafeInteger(requested.memoryMb) || requested.memoryMb < 1) {
    throw new Error(
      "Tangle exact process memoryMb must be a positive integer",
    );
  }
  if (
    !Number.isSafeInteger(requested.diskMb) ||
    requested.diskMb < 1 ||
    requested.diskMb % 1_024 !== 0
  ) {
    throw new Error(
      "Tangle exact process diskMb must be a positive whole number of gibibytes",
    );
  }
  return {
    cpuCores: requested.cpu,
    memoryMB: requested.memoryMb,
    diskGB: requested.diskMb / 1_024,
  };
}

function assertExactProcessListQuery(
  query: { metadata?: Record<string, unknown>; providerOptions?: Record<string, unknown>; signal?: AbortSignal } | undefined,
): void {
  if (
    query !== undefined &&
    (!query ||
      typeof query !== "object" ||
      Array.isArray(query) ||
      (Object.getPrototypeOf(query) !== Object.prototype &&
        Object.getPrototypeOf(query) !== null))
  ) {
    throw new Error("Tangle exact process list query must be a plain object");
  }
  if (query?.metadata !== undefined) {
    if (
      !query.metadata ||
      typeof query.metadata !== "object" ||
      Array.isArray(query.metadata) ||
      !isBoundedJson(query.metadata)
    ) {
      throw new Error("Tangle exact process metadata query exceeds its bound");
    }
  }
  if (query !== undefined) {
    const keys = new Set(Object.keys(query));
    for (const key of ["metadata", "providerOptions", "signal"]) keys.delete(key);
    if (keys.size > 0) throw new Error("Tangle exact process list query contains unsupported fields");
  }
}
