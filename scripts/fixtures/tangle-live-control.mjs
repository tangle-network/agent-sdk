import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  AgentExactRunControlRefSchema,
  agentRunCancellationRequestDigest,
  interactionResponseCommandDigest,
  workspaceCheckpointRequestDigest,
  workspaceForkRequestDigest,
} from "@tangle-network/agent-interface";
import { runSessionReplayConformance, runWorkspaceBranchingConformance } from "@tangle-network/agent-provider-testkit";
import { createTangleProvider } from "@tangle-network/agent-provider-tangle";
import { Sandbox } from "@tangle-network/sandbox";

const PROVIDER = "tangle-sandbox";
const OWNER = "agent-sdk-upstream-evidence";
const DEFAULT_MODEL_PROVIDER = "tangle-router";
const DEFAULT_MODEL = "tangle-router/glm-5.3";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const ABSENCE_ATTEMPTS = 20;
const EVIDENCE_REPOSITORY_URL =
  "https://github.com/tangle-network/agent-sdk.git";
const EVIDENCE_REPOSITORY_REF = "main";
const NESTED_WORKSPACE_CWD = "packages/agent-interface";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sandboxClient() {
  return new Sandbox({
    apiKey: requiredEnvironment("TANGLE_API_KEY"),
    baseUrl: requiredEnvironment("TANGLE_SANDBOX_URL"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

function provider(defaultBackend = "opencode") {
  return createTangleProvider({
    client: sandboxClient(),
    defaultBackend,
    name: PROVIDER,
  });
}

function profile(name, harness, permissions) {
  const modelConfiguration = configuredModel();
  return {
    name,
    harness,
    tools: { bash: true },
    model: {
      provider: modelConfiguration.provider,
      default: modelConfiguration.id,
    },
    ...(permissions === undefined ? {} : { permissions }),
  };
}

function configuredModel() {
  const modelProvider =
    process.env.TANGLE_MODEL_PROVIDER?.trim() || DEFAULT_MODEL_PROVIDER;
  const requestedModel = process.env.TANGLE_MODEL?.trim() || DEFAULT_MODEL;
  const qualifiedPrefix = `${modelProvider}/`;
  const model = requestedModel.startsWith(qualifiedPrefix)
    ? requestedModel.slice(qualifiedPrefix.length)
    : requestedModel;
  if (!model) throw new Error("TANGLE_MODEL cannot be empty");
  return {
    provider: modelProvider,
    id: model,
    requested: `${modelProvider}/${model}`,
  };
}

function sourceInput(proofId, purpose, options = {}) {
  const backend = options.backend ?? "opencode";
  return {
    profile: profile(`${purpose}-${proofId}`, backend, options.permissions),
    backend,
    workspace: {
      environment: "universal",
      repoUrl: EVIDENCE_REPOSITORY_URL,
      gitRef: EVIDENCE_REPOSITORY_REF,
      ...(options.cwd === undefined
        ? {}
        : { cwd: { base: "repository", path: options.cwd } }),
    },
    name: `${purpose}-${proofId}`,
    idempotencyKey: `${purpose}-${proofId}`,
    metadata: { owner: OWNER, proofId, purpose },
  };
}

async function workspaceCwdObservation(environment) {
  assert.equal(typeof environment.exec, "function");
  const result = await environment.exec(
    "printf '%s\\n' \"$(pwd)\" \"$(git rev-parse --show-toplevel)\" \"$(git rev-parse --show-prefix)\"",
  );
  assert.equal(result.exitCode, 0, `workspace cwd probe failed: ${result.stderr}`);
  assert(result.stdout.endsWith("\n"), "workspace cwd probe omitted its final line");
  const lines = result.stdout.slice(0, -1).split("\n");
  assert.equal(lines.length, 3, `workspace cwd probe returned ${JSON.stringify(result.stdout)}`);
  const [cwd, repositoryRoot, repositoryPrefix] = lines;
  assert(cwd, "workspace cwd probe returned no current directory");
  assert(repositoryRoot, "workspace cwd probe returned no repository root");
  assert(repositoryPrefix !== undefined, "workspace cwd probe returned no repository prefix");
  return { cwd, repositoryRoot, repositoryPrefix };
}

async function proveWorkspaceCwd(environment, expectedCwd) {
  const observed = await workspaceCwdObservation(environment);
  if (expectedCwd === undefined) {
    assert.equal(observed.cwd, observed.repositoryRoot);
    assert.equal(observed.repositoryPrefix, "");
  } else {
    assert.equal(observed.repositoryPrefix, `${expectedCwd}/`);
    assert.notEqual(observed.cwd, observed.repositoryRoot);
  }
  return {
    expected: expectedCwd ?? ".",
    observed,
  };
}

function exactControlRef(reference) {
  return AgentExactRunControlRefSchema.parse(reference.controlRef);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freshEnvironment(environmentId) {
  // Recovery must use the sandbox's identity, not this process's create default.
  const next = provider("codex");
  assert.equal(typeof next.get, "function", "Tangle provider has no get() method");
  return await next.get(environmentId);
}

async function destroyAndConfirm(environment) {
  assert.equal(
    typeof environment.destroy,
    "function",
    `Tangle environment ${environment.id} has no destroy() method`,
  );
  await environment.destroy();
  for (let attempt = 0; attempt < ABSENCE_ATTEMPTS; attempt += 1) {
    if ((await freshEnvironment(environment.id)) === null) return;
    await pause(POLL_INTERVAL_MS);
  }
  throw new Error(`Tangle environment ${environment.id} remained after cleanup`);
}

async function withOwnedEnvironment(input, operation) {
  const environmentProvider = provider();
  let environment;
  let operationError;
  try {
    environment = await environmentProvider.create(input);
    return await operation({ environment, environmentProvider });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (environment !== undefined) {
      try {
        await destroyAndConfirm(environment);
      } catch (cleanupError) {
        throw new AggregateError(
          operationError === undefined
            ? [cleanupError]
            : [operationError, cleanupError],
          operationError === undefined
            ? "Tangle evidence cleanup failed"
            : "Tangle evidence and cleanup failed",
        );
      }
    }
  }
}

async function waitForEvent(session, predicate, label) {
  const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const observed = [];
  try {
    for await (const event of session.events({ signal })) {
      observed.push({
        id: event.id,
        type: event.type,
        normalizedType: event.normalized?.type,
      });
      if (predicate(event)) return event;
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Timed out waiting for ${label}`, { cause: error });
    }
    throw error;
  }
  throw Object.assign(
    new Error(`The retained event stream ended before ${label}`),
    { observed },
  );
}

async function waitForSessionStatus(session, expected, label) {
  const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  let observed;
  try {
    while (true) {
      observed = await session.status({ signal });
      if (observed === expected) return observed;
      await pause(POLL_INTERVAL_MS);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `Timed out waiting for ${label}; last status=${observed ?? "unknown"}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function requiredInteraction(session, predicate, label) {
  try {
    return await waitForEvent(session, predicate, label);
  } catch (error) {
    const result = await session
      .result({ signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
      .catch((resultError) => ({
        error: resultError instanceof Error ? resultError.message : String(resultError),
      }));
    const summary = {
      observed: error?.observed ?? [],
      result: {
        success: result?.success,
        text:
          typeof result?.text === "string"
            ? result.text.slice(0, 500)
            : undefined,
        error: result?.error,
        metadata: result?.metadata,
      },
    };
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(summary)}`,
      { cause: error },
    );
  }
}

function permissionResponseCommand(request, proofId, operationSuffix) {
  const binding = {
    ...request.binding,
    requestDigest: request.requestDigest,
  };
  const answerField = request.answerSpec.fields[0];
  assert(answerField, "The permission interaction omitted its answer field");
  assert.equal(answerField.type, "select");
  const answer = answerField.options[0];
  assert(answer, "The permission interaction omitted its first option");
  const response = {
    id: request.id,
    outcome: "accepted",
    data: { [answerField.name]: [answer.value] },
  };
  return {
    operationId: `up09-response-${operationSuffix}-${proofId}`,
    binding,
    response,
    commandDigest: interactionResponseCommandDigest({ binding, response }),
  };
}

async function resolveSubsequentPermissions(session, since, proofId) {
  assert.equal(typeof since, "string");
  let count = 0;
  const observedTypes = [];
  const observedInteractionKinds = [];
  const terminalFrames = [];
  const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  try {
    for await (const event of session.events({ since, signal })) {
      observedTypes.push(event.type);
      if (event.type === "result" || event.type === "done") {
        const data = event.data && typeof event.data === "object" ? event.data : {};
        const outcome = data.outcome && typeof data.outcome === "object" ? data.outcome : {};
        terminalFrames.push({
          type: event.type,
          status: typeof data.status === "string" ? data.status : undefined,
          success: typeof data.success === "boolean" ? data.success : undefined,
          outcomeType: typeof outcome.type === "string" ? outcome.type : undefined,
          outcomeStatus: typeof outcome.status === "string" ? outcome.status : undefined,
          hasInteraction: Object.hasOwn(data, "interaction"),
        });
      }
      const request =
        event.normalized?.type === "interaction" &&
        event.normalized.request.kind === "permission"
          ? event.normalized.request
          : undefined;
      if (event.normalized?.type === "interaction") {
        observedInteractionKinds.push(event.normalized.request.kind);
      }
      if (request === undefined) continue;
      assert.equal(request.subject?.type, "tool");
      assert.equal(request.subject?.toolName, "bash");
      const command = permissionResponseCommand(
        request,
        proofId,
        `followup-${count}`,
      );
      const acknowledgement = await session.respondToInteraction(command);
      assert(
        acknowledgement.status === "accepted" ||
          acknowledgement.status === "already_resolved_same",
        `follow-up permission response was not accepted or replayed: ${acknowledgement.status}`,
      );
      count += 1;
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error("Timed out draining follow-up permission interactions", {
        cause: error,
      });
    }
    throw error;
  }
  return { count, observedTypes, observedInteractionKinds, terminalFrames };
}

async function runRetainedEvidence() {
  const proofId = randomUUID();
  const nestedCwd = await withOwnedEnvironment(
    sourceInput(proofId, "up09-cwd", { cwd: NESTED_WORKSPACE_CWD }),
    async ({ environment }) => {
      const recovered = await freshEnvironment(environment.id);
      assert(recovered, "The environment was not recoverable before inference");
      assert.deepEqual(
        recovered.capabilities.profile.systemPrompt,
        environment.capabilities.profile.systemPrompt,
      );
      assert.deepEqual(recovered.capabilities.interactions, environment.capabilities.interactions);
      assert.equal(typeof recovered.respondToInteraction, "function");
      return proveWorkspaceCwd(recovered, NESTED_WORKSPACE_CWD);
    },
  );
  const replayInput = sourceInput(proofId, "up09-replay", {
    cwd: NESTED_WORKSPACE_CWD,
  });
  const replay = await runSessionReplayConformance({
    name: `tangle-live-replay-${proofId}`,
    createProvider: async () => provider(),
    createInput: replayInput,
    turn: {
      prompt: `Reply with exactly UP09_REPLAY_${proofId.replaceAll("-", "_")}.`,
      sessionId: `up09-replay-session-${proofId}`,
      turnId: `up09-replay-turn-${proofId}`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    reconnect: async (reference) => {
      const controlRef = exactControlRef(reference);
      const environment = await freshEnvironment(controlRef.environmentId);
      assert(environment, "The retained Tangle environment was not recoverable");
      assert.equal(typeof environment.session, "function");
      return environment.session(reference.id, { controlRef });
    },
  });

  const interactionInput = sourceInput(proofId, "up09-interaction", {
    // The generic request_permission MCP tool is the proof boundary. OpenCode
    // must not add a second native bash prompt after that answer, because the
    // hosted sidecar exposes only the generic interaction stream.
    cwd: NESTED_WORKSPACE_CWD,
    permissions: { bash: "allow" },
  });
  const interaction = await withOwnedEnvironment(
    interactionInput,
    async ({ environment, environmentProvider }) => {
      assert.equal(environment.creation, "created");
      const replayedEnvironment = await environmentProvider.create(interactionInput);
      assert.equal(replayedEnvironment.id, environment.id);
      assert.equal(replayedEnvironment.creation, "replayed");
      assert.equal(typeof environment.dispatch, "function");
      assert.equal(typeof environment.session, "function");

      const reference = await environment.dispatch({
        prompt:
          "Find the available MCP tool whose name ends in _request_permission; call that namespaced tool with tool_name exactly bash and input exactly {command: \"printf UP09_PERMISSION\"}. Wait for the permission result. If it is allowed, run that exact bash command and then return only its output.",
        sessionId: `up09-interaction-session-${proofId}`,
        turnId: `up09-interaction-turn-${proofId}`,
        detach: true,
        interactions: { permission: true },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const controlRef = exactControlRef(reference);
      const session = environment.session(reference.id, { controlRef });
      assert.equal(typeof session.respondToInteraction, "function");
      assert.equal(typeof session.cancelRun, "function");

      const event = await requiredInteraction(
        session,
        (candidate) =>
          candidate.normalized?.type === "interaction" &&
          candidate.normalized.request.kind === "permission",
        "a permission interaction",
      );
      const request = event.normalized.request;
      assert.equal(request.subject?.type, "tool");
      assert.equal(request.subject?.toolName, "bash");
      const command = permissionResponseCommand(request, proofId, "initial");
      const acknowledgement = await session.respondToInteraction(command);
      assert(
        acknowledgement.status === "accepted" ||
          acknowledgement.status === "already_resolved_same",
        `permission response was not accepted or replayed: ${acknowledgement.status}`,
      );

      const recoveredEnvironment = await freshEnvironment(environment.id);
      assert(recoveredEnvironment, "The interaction environment was not recoverable");
      assert.deepEqual(
        recoveredEnvironment.capabilities.profile.systemPrompt,
        environment.capabilities.profile.systemPrompt,
        "recovery changed prompt capabilities to the provider's create default",
      );
      assert.deepEqual(
        recoveredEnvironment.capabilities.interactions,
        environment.capabilities.interactions,
        "recovery lost or changed the sandbox's interaction capabilities",
      );
      assert.equal(typeof recoveredEnvironment.session, "function");
      const recoveredSession = recoveredEnvironment.session(reference.id, {
        controlRef,
      });
      assert.equal(typeof recoveredSession.respondToInteraction, "function");
      const replayedAcknowledgement = await recoveredSession.respondToInteraction(command);
      assert.equal(replayedAcknowledgement.status, "already_resolved_same");
      assert.equal(replayedAcknowledgement.operationId, acknowledgement.operationId);
      assert.equal(replayedAcknowledgement.commandDigest, acknowledgement.commandDigest);
      assert.deepEqual(replayedAcknowledgement.binding, acknowledgement.binding);
      const followUpPermissions = await resolveSubsequentPermissions(
        recoveredSession,
        event.id,
        proofId,
      );
      const followUpPermissionCount = followUpPermissions.count;
      const result = await recoveredSession.result({
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      assert.equal(
        result.metadata?.terminal,
        true,
        `permission run did not terminate: followUp=${JSON.stringify(followUpPermissions)}; result=${JSON.stringify(result)}`,
      );
      assert.equal(result.success, true);
      assert(
        typeof result.text === "string" &&
          result.text.includes("UP09_PERMISSION"),
        "the accepted permission did not release the exact bash command",
      );

      const cancelReference = await recoveredEnvironment.dispatch({
        prompt:
          "Find the available MCP tool whose name ends in _request_permission; call that namespaced tool with tool_name exactly bash and input exactly {command: \"printf UP09_CANCEL_PERMISSION\"}. Do not run bash until permission is granted.",
        sessionId: `up09-cancel-session-${proofId}`,
        turnId: `up09-cancel-turn-${proofId}`,
        detach: true,
        interactions: { permission: true },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const cancelControlRef = exactControlRef(cancelReference);
      const cancelSession = recoveredEnvironment.session(cancelReference.id, {
        controlRef: cancelControlRef,
      });
      await requiredInteraction(
        cancelSession,
        (candidate) =>
          candidate.normalized?.type === "interaction" &&
          candidate.normalized.request.kind === "permission",
        "the cancellable permission interaction",
      );
      assert.equal(typeof cancelSession.cancelRun, "function");
      const cancellationMaterial = {
        operationId: `up09-cancel-${proofId}`,
        run: cancelControlRef,
        reason: "UP-09 retained cancellation evidence",
      };
      const cancellationRequest = {
        ...cancellationMaterial,
        requestDigest: agentRunCancellationRequestDigest(cancellationMaterial),
      };
      const cancellation = await cancelSession.cancelRun(cancellationRequest);
      assert.equal(cancellation.status, "accepted");
      assert(
        cancellation.effect === "cancel_requested" ||
          cancellation.effect === "cancelled",
        `cancellation did not affect a live run: ${cancellation.effect}`,
      );

      const cancellationEnvironment = await freshEnvironment(environment.id);
      assert(cancellationEnvironment, "The cancelled environment was not recoverable");
      assert.equal(typeof cancellationEnvironment.session, "function");
      const cancellationSession = cancellationEnvironment.session(
        cancelReference.id,
        { controlRef: cancelControlRef },
      );
      assert.equal(typeof cancellationSession.cancelRun, "function");
      const cancellationStatus = await waitForSessionStatus(
        cancellationSession,
        "cancelled",
        "the cancelled session status",
      );
      const cancellationReplay = await cancellationSession.cancelRun(
        cancellationRequest,
      );
      assert.equal(cancellationReplay.status, "replayed");
      assert.equal(cancellationReplay.requestDigest, cancellation.requestDigest);
      assert.deepEqual(cancellationReplay.run, cancellation.run);
      assert.equal(cancellationReplay.effect, cancellation.effect);

      return {
        environmentId: environment.id,
        createReplay: true,
        interactionKind: request.kind,
        interactionResponse: acknowledgement.status,
        interactionReplay: true,
        followUpPermissionCount,
        cancellation: cancellation.status,
        cancellationEffect: cancellation.effect,
        cancellationStatus,
        cancellationReplay: cancellationReplay.status,
      };
    },
  );

  return {
    proofId,
    requestedModel: configuredModel().requested,
    nestedCwd,
    replay,
    interaction,
    cleanupConfirmed: true,
  };
}

function childLookup(sourceEnvironmentId, kind, request) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "recover-workspace"],
    {
      encoding: "utf8",
      env: process.env,
      input: JSON.stringify({ sourceEnvironmentId, kind, request }),
      maxBuffer: 10 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Fresh-process ${kind} lookup failed (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
  if (process.env.TANGLE_DEBUG_WORKSPACE === "1" && result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Fresh-process ${kind} lookup returned invalid output`);
  }
  return JSON.parse(lines[0]);
}

async function recoverWorkspace() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const next = provider();
  assert.equal(typeof next.workspaceBranching?.forEnvironment, "function");
  const operations = await next.workspaceBranching.forEnvironment(
    input.sourceEnvironmentId,
  );
  assert(operations, "The source workspace branching handle was not recoverable");
  const result =
    input.kind === "checkpoint"
      ? await operations.lookupCheckpoint(input.request)
      : input.kind === "fork"
        ? await operations.lookupFork(input.request)
        : undefined;
  if (result === undefined) throw new Error("Unknown workspace lookup kind");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runWorkspaceEvidence() {
  const proofId = randomUUID();
  const input = sourceInput(proofId, "up14-workspace");
  return await withOwnedEnvironment(input, async ({ environment }) => {
    const defaultCwd = await proveWorkspaceCwd(environment);
    assert.equal(typeof environment.dispatch, "function");
    assert.equal(typeof environment.session, "function");
    assert(environment.workspaceBranching, "Tangle did not grant workspace branching");

    const reference = await environment.dispatch({
      prompt: `Reply with exactly UP14_SOURCE_${proofId.replaceAll("-", "_")}.`,
      sessionId: `up14-source-session-${proofId}`,
      turnId: `up14-source-turn-${proofId}`,
      detach: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const source = exactControlRef(reference);
    const sourceSession = environment.session(reference.id, { controlRef: source });
    const sourceResult = await sourceSession.result({
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    assert.equal(sourceResult.metadata?.terminal, true);
    assert.equal(typeof environment.write, "function");
    assert.equal(typeof environment.read, "function");
    const markerPath = `.agent-sdk-upstream-evidence/${proofId}.txt`;
    const sourceMarker = `UP14_WORKSPACE_${proofId}\n`;
    await environment.write(markerPath, sourceMarker);
    assert.equal(await environment.read(markerPath), sourceMarker);

    const checkpointMaterial = {
      source,
      name: `up14-checkpoint-${proofId}`,
      metadata: { owner: OWNER, proofId },
    };
    const checkpointRequest = {
      ...checkpointMaterial,
      idempotencyKey: `up14-checkpoint-${proofId}`,
      requestDigest: workspaceCheckpointRequestDigest(checkpointMaterial),
    };
    let freshProcessLookups = 0;
    let workspaceCopied = false;
    let workspaceIsolated = false;
    let firstCheckpoint;
    let expectedForkEnvironment;
    const base = environment.workspaceBranching;
    const operations = {
      checkpoint: async (request, options) => {
        const result = await base.checkpoint(request, options);
        if (firstCheckpoint === undefined && result.status === "created") {
          firstCheckpoint = result.checkpoint;
        }
        return result;
      },
      lookupCheckpoint: async (request) => {
        freshProcessLookups += 1;
        const result = childLookup(environment.id, "checkpoint", request);
        if (result.status === "not_found") return result;
        if (result.status !== "found") {
          throw new Error(
            `Fresh-process checkpoint lookup did not find the created checkpoint: ${JSON.stringify(result)}`,
          );
        }
        if (firstCheckpoint !== undefined &&
            JSON.stringify(result.checkpoint) !== JSON.stringify(firstCheckpoint)) {
          throw new Error(
            `Fresh-process checkpoint lookup returned different checkpoint material: created=${JSON.stringify(firstCheckpoint)} found=${JSON.stringify(result.checkpoint)}`,
          );
        }
        return result;
      },
      deleteCheckpoint: (request, options) =>
        base.deleteCheckpoint(request, options),
      fork: async (request, options) => {
        const result = await base.fork(request, options);
        if (result.status === "created") {
          expectedForkEnvironment = result.environment;
          const child = await freshEnvironment(result.environment.environmentId);
          assert(child, "The forked Tangle environment was not recoverable");
          assert.equal(typeof child.read, "function");
          assert.equal(typeof child.write, "function");
          workspaceCopied = (await child.read(markerPath)) === sourceMarker;
          assert(workspaceCopied, "The fork omitted the source workspace marker");
          await child.write(markerPath, `UP14_CHILD_${proofId}\n`);
          workspaceIsolated = (await environment.read(markerPath)) === sourceMarker;
          assert(workspaceIsolated, "The fork mutation changed its source workspace");
        }
        return result;
      },
      lookupFork: async (request) => {
        freshProcessLookups += 1;
        const result = childLookup(environment.id, "fork", request);
        if (result.status === "not_found") return result;
        if (result.status !== "found") {
          throw new Error(
            `Fresh-process fork lookup did not find the created fork: ${JSON.stringify(result)}`,
          );
        }
        if (process.env.TANGLE_DEBUG_WORKSPACE === "1") {
          console.error(
            JSON.stringify({
              forkLookup: result,
              expectedForkEnvironment: expectedForkEnvironment,
            }),
          );
        }
        return result;
      },
      destroyFork: (request, options) => base.destroyFork(request, options),
    };
    const report = await runWorkspaceBranchingConformance({
      name: `tangle-live-workspace-${proofId}`,
      operations,
      checkpointRequest,
      forkRequest: (checkpoint) => {
        const material = {
          checkpoint,
          name: `up14-fork-${proofId}`,
          placement: { kind: "provider" },
          metadata: { owner: OWNER, proofId },
        };
        return {
          ...material,
          idempotencyKey: `up14-fork-${proofId}`,
          requestDigest: workspaceForkRequestDigest(material),
        };
      },
    });
    assert(workspaceCopied);
    assert(workspaceIsolated);
    assert(freshProcessLookups >= 6);

    assert.equal(await freshEnvironment(report.environmentId), null);

    return {
      proofId,
      requestedModel: configuredModel().requested,
      defaultCwd,
      sourceEnvironmentId: environment.id,
      checkpointId: report.checkpointId,
      forkEnvironmentId: report.environmentId,
      checked: report.checked,
      freshProcessLookups,
      workspaceCopied,
      workspaceIsolated,
      forkAbsent: true,
      cleanupConfirmed: true,
    };
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "recover-workspace") {
    await recoverWorkspace();
    return;
  }
  const result =
    mode === "retained"
      ? await runRetainedEvidence()
      : mode === "workspace"
        ? await runWorkspaceEvidence()
        : undefined;
  if (result === undefined) throw new Error(`Unknown Tangle evidence mode ${mode}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  if (error instanceof AggregateError) {
    for (const [index, nested] of error.errors.entries()) {
      console.error(
        `nested error ${index + 1}:`,
        nested?.stack ?? String(nested),
      );
    }
  }
  process.exitCode = 1;
});
