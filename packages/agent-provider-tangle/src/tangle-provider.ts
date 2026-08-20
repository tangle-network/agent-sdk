import {
  AgentEnvironmentCapabilitiesSchema,
  createAgentEnvironmentWithIdempotency,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentCreateIdempotencyRecord,
  AgentEnvironmentProvider,
  AgentEnvironmentQuery,
  AgentEnvironmentSummary,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  createTangleExactProcessProvider,
} from "./exact-process.js";
import {
  capabilitiesForClient,
  defaultTangleSandboxCapabilities,
  narrowTangleCapabilitiesToBackend,
} from "./tangle-capabilities.js";
import { sandboxInstanceAsEnvironment } from "./tangle-environment.js";
import { assertCreateInputShape, assertMappedCreateOptions, assertMappedSecretNames, assertNoInlineSecretValues, sandboxOptionsFromCreateInput } from "./tangle-create-options.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import { requestedResourceProfile } from "./tangle-resources.js";
import type { TangleProviderOptions } from "./tangle-types.js";
import {
  assertBoundedJson,
  attachCleanupHandle,
  awaitWithSignal,
  boundedIdentifier,
  boundedString,
  MAX_LIST_RESULTS,
} from "./tangle-contract-safety.js";

export function createTangleProvider(
  options: TangleProviderOptions,
): AgentEnvironmentProvider {
  const providerName = options.name ?? "tangle-sandbox";
  boundedIdentifier(providerName, "Tangle provider name");
  const exactProcess = options.exactProcess
    ? createTangleExactProcessProvider({
        client: options.client,
        options: options.exactProcess,
        providerName,
      })
    : undefined;
  const resolveDeclaredCapabilities = async (): Promise<AgentEnvironmentCapabilities> => {
    const configured = options.capabilities
      ? typeof options.capabilities === "function"
        ? await options.capabilities()
        : options.capabilities
      : defaultTangleSandboxCapabilities();
    if (!exactProcess && configured.exactProcess) {
      throw new Error(
        "Tangle capabilities cannot advertise exactProcess without exactProcess configuration",
      );
    }
    const backend =
      configured.interactions === undefined
        ? undefined
        : await resolveDefaultBackend(options.client, options.defaultBackend);
    const narrowed = narrowTangleCapabilitiesToBackend(configured, backend);
    return exactProcess
      ? {
          ...narrowed,
          exactProcess: { egress: ["blocked", "strict"] as const },
        }
      : narrowed;
  };
  // Provider-boundary document: client-stage facts only. It also validates
  // the configured document, so create() and get() call it before any effect.
  const narrowedProviderCapabilities = (
    declared: AgentEnvironmentCapabilities,
  ): AgentEnvironmentCapabilities =>
    AgentEnvironmentCapabilitiesSchema.parse(
      capabilitiesForClient(declared, options.client),
    );
  const resolveCapabilities = async (): Promise<AgentEnvironmentCapabilities> =>
    narrowedProviderCapabilities(await resolveDeclaredCapabilities());
  const createRecords = new Map<
    string,
    AgentEnvironmentCreateIdempotencyRecord<AgentEnvironment>
  >();
  const createEnvironment = async (
    input: CreateAgentEnvironmentInput,
  ): Promise<AgentEnvironment> => {
    assertCreateInputShape(input);
    input.signal?.throwIfAborted();
    assertNoInlineSecretValues(input);
    if (input.providerOptions && Object.keys(input.providerOptions).length > 0) {
      throw new Error("Tangle create providerOptions are not supported");
    }
    // The sandbox stage narrows from the declared document, not the
    // provider-boundary one: the client stage cannot observe box-scoped
    // facts, so measured instance facts must decide them per sandbox.
    const declaredCapabilities = await resolveDeclaredCapabilities();
    narrowedProviderCapabilities(declaredCapabilities);
    const createOptions =
      options.mapCreateInput?.(input) ??
      sandboxOptionsFromCreateInput(input, options.defaultBackend ?? "opencode");
    assertMappedCreateOptions(createOptions);
    if (
      input.idempotencyKey !== undefined &&
      createOptions.idempotencyKey !== input.idempotencyKey
    ) {
      throw new Error(
        "Tangle mapped create options must preserve input idempotencyKey",
      );
    }
    assertMappedSecretNames(createOptions);
    input.signal?.throwIfAborted();
    const createPromise = options.client.create(
      createOptions,
      input.signal ? { signal: input.signal } : undefined,
    );
    let box: Awaited<typeof createPromise>;
    try {
      box = await awaitWithSignal(createPromise, input.signal);
    } catch (error) {
      if (input.signal?.aborted) {
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
      input.signal?.throwIfAborted();
      const requestedResources = requestedResourceProfile(input.resources);
      const environment = await sandboxInstanceAsEnvironment(
        box,
        providerName,
        options.client,
        declaredCapabilities,
        input.signal ? { signal: input.signal } : undefined,
        requestedResources === undefined ? undefined : { resources: requestedResources },
      );
      input.signal?.throwIfAborted();
      return environment;
    } catch (error) {
      if (!box.delete) {
        const baseError = error instanceof Error ? error : new Error(String(error));
        throw Object.assign(baseError, { cleanupHandle: box });
      }
      try {
        await box.delete();
      } catch (cleanupError) {
        const combined = new AggregateError([error, cleanupError], "Tangle environment validation and cleanup both failed");
        attachCleanupHandle(combined, box, cleanupError);
        throw combined;
      }
      throw error;
    }
  };
  return {
    name: providerName,
    ...(exactProcess ? { exactProcess } : {}),
    capabilities: resolveCapabilities,
    ...(options.validateProfile ? { validateProfile: options.validateProfile } : {}),
    create(input) {
      return createAgentEnvironmentWithIdempotency(
        createRecords,
        input,
        () => createEnvironment(input),
      );
    },
    ...(options.client.get
      ? {
          async get(id: string, operation?: { signal?: AbortSignal }): Promise<AgentEnvironment | null> {
            assertProviderOperationOptions(operation, "Tangle get");
            boundedIdentifier(id, "Tangle environment id");
            const declaredCapabilities = await resolveDeclaredCapabilities();
            narrowedProviderCapabilities(declaredCapabilities);
            operation?.signal?.throwIfAborted();
            const box = await awaitWithSignal(options.client.get?.(id, operation), operation?.signal);
            operation?.signal?.throwIfAborted();
            if (!box || boundedIdentifier(box.id, "Tangle environment id") !== id) return null;
            return await sandboxInstanceAsEnvironment(
              box,
              providerName,
              options.client,
              declaredCapabilities,
              operation?.signal ? { signal: operation.signal } : undefined,
            );
          },
        }
      : {}),
    ...(options.client.list
      ? {
          async list(query?: AgentEnvironmentQuery, operation?: { signal?: AbortSignal }): Promise<AgentEnvironmentSummary[]> {
            assertProviderOperationOptions(operation, "Tangle list");
            assertEnvironmentQuery(query);
            operation?.signal?.throwIfAborted();
            if (query?.name !== undefined) boundedString(query.name, "Tangle environment query name");
            if (query?.providerOptions && Object.keys(query.providerOptions).length > 0) {
              throw new Error("Tangle environment list providerOptions are not supported");
            }
            if (query?.providerOptions !== undefined) {
              if (!query.providerOptions || typeof query.providerOptions !== "object" || Array.isArray(query.providerOptions)) {
                throw new Error("Tangle environment list providerOptions must be a JSON object");
              }
              assertBoundedJson(query.providerOptions);
            }
            if (query?.metadata !== undefined) {
              if (!query.metadata || typeof query.metadata !== "object" || Array.isArray(query.metadata)) {
                throw new Error("Tangle environment query metadata must be a JSON object");
              }
              assertBoundedJson(query.metadata);
            }
            const boxes = await awaitWithSignal(options.client.list?.(operation?.signal ? { signal: operation.signal } : undefined), operation?.signal);
            if (!Array.isArray(boxes) || boxes.length > MAX_LIST_RESULTS) {
              throw new Error("Tangle environment list exceeded its result bound");
            }
            const summaries = (boxes ?? []).filter((box) => {
              boundedIdentifier(box.id, "Tangle environment id");
              if (box.name !== undefined) boundedString(box.name, "Tangle environment name");
              if (box.metadata !== undefined) {
                if (!box.metadata || typeof box.metadata !== "object" || Array.isArray(box.metadata)) {
                  throw new Error("Tangle environment metadata must be a JSON object");
                }
                assertBoundedJson(box.metadata);
              }
              const nameMatches = query?.name === undefined || box.name === query.name;
              const metadataMatches = query?.metadata === undefined ||
                Object.entries(query.metadata).every(([key, value]) => Object.hasOwn(box.metadata ?? {}, key) && JSON.stringify(box.metadata?.[key]) === JSON.stringify(value));
              return nameMatches && metadataMatches;
            }).map((box) => ({
              id: boundedIdentifier(box.id, "Tangle environment id"),
              provider: providerName,
              ...(box.name ? { name: box.name } : {}),
              status: statusFromUnknown(box.status),
              ...(box.metadata ? { metadata: box.metadata } : {}),
            }));
            operation?.signal?.throwIfAborted();
            return summaries;
          },
        }
      : {}),
  };
}

async function resolveDefaultBackend(
  client: TangleProviderOptions["client"],
  defaultBackend: TangleProviderOptions["defaultBackend"],
) {
  if (defaultBackend === undefined) return undefined;
  try {
    if (client.getBackend) return await client.getBackend(defaultBackend);
    if (!client.listBackends) return undefined;
    const catalog = await client.listBackends();
    return catalog.backends.find((backend) => backend.type === defaultBackend);
  } catch {
    return undefined;
  }
}

function assertProviderOperationOptions(
  options: { signal?: AbortSignal } | undefined,
  label: string,
): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${label} options must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (key !== "signal") throw new Error(`${label} options contain unsupported fields`);
  }
}

function assertEnvironmentQuery(query: AgentEnvironmentQuery | undefined): void {
  if (query === undefined) return;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Tangle environment query must be an object");
  }
  const keys = new Set(Object.keys(query));
  for (const key of ["name", "metadata", "providerOptions"]) keys.delete(key);
  if (keys.size > 0) throw new Error("Tangle environment query contains unsupported fields");
}
