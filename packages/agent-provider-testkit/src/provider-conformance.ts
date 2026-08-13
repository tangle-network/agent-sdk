import { AgentEnvironmentCapabilitiesSchema } from "@tangle-network/agent-interface/environment-provider";
import type { ProviderConformanceOptions, ProviderConformanceReport } from "./conformance-types.js";
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

  const environment = await provider.create({
    profile: { name: `${options.name}-profile` },
    backend: "test",
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  });
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

/** Prove detach plus stable event replay through a reconstructed session client. */
