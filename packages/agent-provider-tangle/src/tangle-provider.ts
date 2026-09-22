import {
  AgentEnvironmentCapabilitiesSchema,
  AgentEnvironmentCreateRetryBlockedError,
  attachAgentEnvironmentCreateRetention,
  createAgentEnvironmentResource,
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
} from "./tangle-capabilities.js";
import { sandboxInstanceAsEnvironment } from "./tangle-environment.js";
import { assertCreateInputShape, assertMappedCreateOptions, assertMappedSecretNames, assertNoInlineSecretValues, sandboxOptionsFromCreateInput } from "./tangle-create-options.js";
import { statusFromUnknown } from "./tangle-environment-values.js";
import { requestedResourceProfile } from "./tangle-resources.js";
import type { TangleProviderOptions } from "./tangle-types.js";
import {
  assertBoundedJson,
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
    return exactProcess
      ? {
          ...configured,
          exactProcess: { egress: ["blocked", "strict"] as const },
        }
      : configured;
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
    if (
      input.idempotencyKey !== undefined &&
      declaredCapabilities.environmentCreate?.idempotency !== "durable"
    ) {
      throw new Error(
        "Tangle capabilities do not advertise durable environment idempotency",
      );
    }
    if (
      input.secrets !== undefined &&
      declaredCapabilities.environmentCreate?.secretReferences !== true
    ) {
      throw new Error(
        "Tangle capabilities do not advertise environment secret references",
      );
    }
    const createOptions =
      options.mapCreateInput?.(input) ??
      sandboxOptionsFromCreateInput(input, options.defaultBackend ?? "opencode");
    assertMappedCreateOptions(createOptions);
    if (createOptions.idempotencyKey !== input.idempotencyKey) {
      throw new Error(
        input.idempotencyKey === undefined
          ? "Tangle mapped create options must not add input idempotencyKey"
          : "Tangle mapped create options must preserve input idempotencyKey",
      );
    }
    assertMappedSecretNames(createOptions, input.secrets);
    input.signal?.throwIfAborted();
    const createPromise = options.client.create(
      createOptions,
      input.signal ? { signal: input.signal } : undefined,
    );
    return createAgentEnvironmentResource(
      createPromise,
      input.signal,
      async (box) => {
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
        return attachAgentEnvironmentCreateRetention(
          environment,
          createRecords,
          input.idempotencyKey,
        );
      },
      async (box) => {
        if (!box.delete) {
          const error = new AgentEnvironmentCreateRetryBlockedError(
            "Tangle sandbox allocation has no cleanup operation",
          );
          Object.assign(error, { cleanupHandle: box });
          throw error;
        }
        await box.delete();
      },
    );
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
        (snapshot) => createEnvironment(snapshot),
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
