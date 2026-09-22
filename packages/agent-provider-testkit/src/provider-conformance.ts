import {
  AgentEnvironmentCapabilitiesSchema,
  withoutAgentEnvironmentCreateSignal,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  ProviderConformanceOptions,
  ProviderConformanceReport,
} from "./conformance-types.js";
import { assert, checkCapabilityExposure, checkWorkspace, collect, environmentCapabilityDocument, isTerminalEvent, withEnvironmentCleanup } from "./conformance-helpers.js";

export async function runAgentEnvironmentProviderConformance(
  options: ProviderConformanceOptions,
): Promise<ProviderConformanceReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  assert(provider.name, "provider.name must be non-empty", checked);
  assert(typeof provider.capabilities === "function", "provider.capabilities must be a function", checked);
  checked.push("provider-shape");

  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(capabilities.profile !== undefined, "capabilities.profile is required", checked);
  assert(capabilities.streaming !== undefined, "capabilities.streaming is required", checked);
  assert(capabilities.workspace !== undefined, "capabilities.workspace is required", checked);
  checked.push("capabilities");

  const createInput: CreateAgentEnvironmentInput = {
    profile: { name: `${options.name}-profile` },
    backend: "test",
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  };
  const durableCreate = capabilities.environmentCreate?.idempotency === "durable";
  if (durableCreate && createInput.idempotencyKey === undefined) {
    createInput.idempotencyKey = `${options.name}-environment-create`;
  }
  if (!durableCreate) {
    delete createInput.idempotencyKey;
    checked.push("create-idempotency-not-advertised");
  }
  if (options.createSecrets !== undefined) {
    if (capabilities.environmentCreate?.secretReferences !== true) {
      let secretRejected = false;
      try {
        await provider.create({
          ...createInput,
          idempotencyKey: undefined,
          secrets: [...options.createSecrets],
        });
      } catch {
        secretRejected = true;
      }
      assert(
        secretRejected,
        "provider must reject generic secrets without secretReferences capability",
        checked,
      );
      checked.push("create-secrets-not-advertised");
    } else {
      createInput.secrets = [...options.createSecrets];
    }
  }
  const environment = await provider.create(createInput);
  return withEnvironmentCleanup(environment, checked, async () => {
    assert(environment.id, "environment.id must be non-empty", checked);
    assert(environment.provider, "environment.provider must be non-empty", checked);
    // Every check below is about this environment, so it binds to the document
    // that describes this environment.
    const environmentCapabilities = environmentCapabilityDocument(
      environment,
      capabilities,
    );
    checked.push("environment-capabilities");
    checkCapabilityExposure(environment, environmentCapabilities, checked);
    if (environmentCapabilities.interactions) {
      assert(
        typeof environment.respondToInteraction === "function",
        "interaction capability requires respondToInteraction()",
        checked,
      );
    }
    if (
      environmentCapabilities.branching.retrySafe ||
      environmentCapabilities.branching.lookup ||
      environmentCapabilities.branching.cleanup
    ) {
      assert(
        environmentCapabilities.branching.checkpoint &&
          environmentCapabilities.branching.fork,
        "durable branching requires checkpoint and fork capabilities",
        checked,
      );
      assert(
        environmentCapabilities.branching.retrySafe &&
          environmentCapabilities.branching.lookup &&
          environmentCapabilities.branching.cleanup,
        "durable branching idempotency, lookup, and cleanup are all-or-nothing",
        checked,
      );
      const branching = environment.workspaceBranching;
      assert(
        branching,
        "durable branching capabilities require workspaceBranching operations",
        checked,
      );
      for (const method of [
        "checkpoint",
        "lookupCheckpoint",
        "deleteCheckpoint",
        "fork",
        "lookupFork",
        "destroyFork",
      ] as const) {
        assert(
          typeof branching[method] === "function",
          `durable branching requires workspaceBranching.${method}()`,
          checked,
        );
      }
    }
    checked.push("create");

    if (durableCreate) {
      const replayInput = withoutAttemptSignal(
        Object.fromEntries(Object.entries(createInput).reverse()) as CreateAgentEnvironmentInput,
      );
      const replay = await provider.create(replayInput);
      assert(
        replay.id === environment.id && replay.provider === environment.provider,
        "same create key and canonical input must return the same environment",
        checked,
      );
      checked.push("create-idempotency");

      const restartedProvider = await options.createProvider();
      const restarted = await restartedProvider.create(replayInput);
      assert(
        restarted.id === environment.id && restarted.provider === environment.provider,
        "same keyed create must reconstruct after provider recreation",
        checked,
      );
      checked.push("create-idempotency-restart");

      let collisionRejected = false;
      try {
        await provider.create({
          ...createInput,
          name: `${createInput.name ?? options.name}-changed`,
        });
      } catch {
        collisionRejected = true;
      }
      assert(
        collisionRejected,
        "reusing a create key with changed input must reject",
        checked,
      );
      checked.push("create-idempotency-collision");

      const mutableInput: CreateAgentEnvironmentInput = {
        ...createInput,
        idempotencyKey: `${createInput.idempotencyKey}-mutation`,
        profile: { name: `${options.name}-mutable` },
        metadata: { ...(createInput.metadata ?? {}), mutation: "before" },
      };
      const mutableCreate = provider.create(mutableInput);
      (mutableInput.profile as { name: string }).name = `${options.name}-after`;
      (mutableInput.metadata as Record<string, unknown>).mutation = "after";
      const mutableEnvironment = await mutableCreate;
      const mutableReplay = await provider.create({
        ...mutableInput,
        profile: { name: `${options.name}-mutable` },
        metadata: { ...(createInput.metadata ?? {}), mutation: "before" },
      });
      assert(
        mutableReplay.id === mutableEnvironment.id,
        "create identity must use the pre-call canonical snapshot",
        checked,
      );
      checked.push("create-idempotency-mutation");
      await destroyIfDistinct(mutableEnvironment, environment);

      const abortInput = withoutAttemptSignal({
        ...createInput,
        idempotencyKey: `${createInput.idempotencyKey}-abort`,
      });
      const abortController = new AbortController();
      const abortedCreate = provider.create({
        ...abortInput,
        signal: abortController.signal,
      });
      abortController.abort(new Error("create waiter cancelled"));
      let createAborted = false;
      try {
        await abortedCreate;
      } catch {
        createAborted = true;
      }
      assert(createAborted, "a create attempt must have an abortable wait", checked);
      const afterAbort = await provider.create(abortInput);
      assert(
        afterAbort.id.length > 0,
        "a late create must remain recoverable after its caller aborts",
        checked,
      );
      checked.push("create-idempotency-abort");
      await destroyIfDistinct(afterAbort, environment);

      const concurrentInput = withoutAttemptSignal({
        ...createInput,
        idempotencyKey: `${createInput.idempotencyKey}-concurrent`,
      });
      const retryController = new AbortController();
      const primary = provider.create(concurrentInput);
      const retry = provider.create({
        ...concurrentInput,
        signal: retryController.signal,
      });
      retryController.abort(new Error("retry waiter cancelled"));
      let retryAborted = false;
      try {
        await retry;
      } catch {
        retryAborted = true;
      }
      const concurrentEnvironment = await primary;
      assert(retryAborted, "a coalesced retry must have its own abortable wait", checked);
      checked.push("create-idempotency-concurrency");
      await destroyIfDistinct(concurrentEnvironment, environment);
    }

    const events = await collect(
      environment.stream({
        prompt: options.prompt ?? "Return the word ok.",
        sessionId: `${options.name}-session`,
        turnId: `${options.name}-turn`,
      }),
    );
    assert(events.length > 0, "stream must emit at least one event", checked);
    assert(
      events.some(isTerminalEvent),
      "stream must emit a terminal result/done/status event",
      checked,
    );
    if (options.requireUsage || environmentCapabilities.usage) {
      assert(
        events.some((event) => Boolean(event.usage)),
        "provider declared usage support but emitted no usage",
        checked,
      );
    }
    checked.push("stream");

    if (environmentCapabilities.nativeContinuation !== undefined) {
      assert(
        typeof environment.session === "function",
        "native continuation requires session()",
        checked,
      );
      const session = environment.session(`${options.name}-native-session`);
      assert(
        typeof session.contextBoundary === "function",
        "native continuation requires session.contextBoundary()",
        checked,
      );
      assert(
        typeof session.continueNative === "function",
        "native continuation requires session.continueNative()",
        checked,
      );
      checked.push("native-continuation-operations");
    }

    if (options.requireDispatch || environmentCapabilities.streaming.detach) {
      assert(
        typeof environment.dispatch === "function",
        "detach support requires dispatch()",
        checked,
      );
      const session = await environment.dispatch?.({
        prompt: options.prompt ?? "Return the word ok.",
        sessionId: `${options.name}-dispatch`,
      });
      assert(session?.id, "dispatch() must return a session id", checked);
      checked.push("dispatch");
    }

    await checkWorkspace(environment, environmentCapabilities, checked);
    checked.push("capability-denial");

    return {
      provider: provider.name,
      environmentId: environment.id,
      capabilities,
      environmentCapabilities,
      events: events.length,
      checked,
    };
  }, true);
}

function withoutAttemptSignal(
  input: CreateAgentEnvironmentInput,
): CreateAgentEnvironmentInput {
  return withoutAgentEnvironmentCreateSignal(input);
}

async function destroyIfDistinct(
  environment: { id: string; destroy?: () => Promise<void> },
  original: { id: string },
): Promise<void> {
  if (environment.id !== original.id) await environment.destroy?.();
}

/** Prove detach plus stable event replay through a reconstructed session client. */
