import { describe, expect, it } from "vitest";
import type {
  AgentCandidateProfileActivation,
  AgentExecutionPreparationAxisResult,
  AgentExecutionPreparationReceipt,
  AgentProfile,
  AgentProfileActivationEvidence,
  AgentWorkspaceSealedLeaseRecord,
  AgentWorkspaceSourceSnapshotPolicy,
  Sha256Digest,
} from "./index.js";
import {
  AGENT_PROFILE_MATERIALIZATION_AXES,
  agentCandidateProfileActivationSchema,
  agentExecutionPreparationAxisResultSchema,
  agentExecutionPreparationReasoningEffortSchema,
  agentExecutionPreparationReceiptSchema,
  AgentExecutionPreparationValidationError,
  agentProfileSchema,
  buildAgentExecutionPreparationReceipt,
  buildAgentWorkspaceLeaseRecord,
  canonicalAgentProfileDigest,
  defineAgentProfilePublicConfig,
  defineAgentProfileSecretRef,
  profileMaterializationAxes,
  profileMaterializationRequests,
} from "./index.js";

const sha = (digit: string): Sha256Digest =>
  `sha256:${digit.repeat(64)}` as Sha256Digest;

const sourceSnapshotPolicy: AgentWorkspaceSourceSnapshotPolicy = {
  kind: "provider-declared",
  name: "agent-runtime/local-private-workspace-source",
  version: 1,
  digest: sha("7"),
};

interface WorkspaceLeaseFixtureOptions {
  leaseId?: string;
  profileActivationDigest?: Sha256Digest;
  preparedWorkspaceDigest?: Sha256Digest;
  policy?: AgentWorkspaceSourceSnapshotPolicy;
  expiresAtMs?: number;
}

function workspaceLeaseFixtureBase(options: WorkspaceLeaseFixtureOptions) {
  return {
    kind: "agent-workspace-lease" as const,
    schemaVersion: 1 as const,
    leaseId: options.leaseId ?? "lease-1",
    ownerId: "discovery-run-1",
    workspace: {
      provider: "agent-runtime/local-private-workspace",
      root: "/private/workspaces/allocation-1",
      identityDigest: sha("2"),
    },
    isolation: "per-run" as const,
    sourceSnapshotDigest: sha("8"),
    sourceSnapshotPolicy: options.policy ?? sourceSnapshotPolicy,
    createdAtMs: 100,
    updatedAtMs: 200,
    expiresAtMs: options.expiresAtMs ?? 3_000,
  };
}

function sealedWorkspaceLease(
  options: WorkspaceLeaseFixtureOptions = {},
): AgentWorkspaceSealedLeaseRecord {
  return buildAgentWorkspaceLeaseRecord({
    ...workspaceLeaseFixtureBase(options),
    phase: "workspace-sealed",
    preparedWorkspaceDigest: options.preparedWorkspaceDigest ?? sha("9"),
    profileActivationDigest: options.profileActivationDigest ?? sha("3"),
    cleanupAttempts: 0,
  });
}

const fullProfile: AgentProfile = {
  name: "researcher",
  description: "Tests mechanisms",
  version: "1",
  tags: ["science"],
  prompt: {
    systemPrompt: "Run discriminating experiments.",
    appendSystemPrompt: "Report the exact command you ran.",
    instructions: ["Keep exact evidence."],
  },
  model: {
    default: "openai/gpt-5.4",
    small: "openai/gpt-5.4-mini",
    provider: "openai",
    reasoningEffort: "high",
    maxVisibleOutputTokens: 8192,
    maxReasoningTokens: 4096,
    maxTotalOutputTokens: 16384,
    metadata: { route: "research" },
  },
  harness: "codex",
  permissions: { shell: "ask" },
  tools: { shell: true },
  mcp: {
    papers: { transport: "http", url: "https://papers.example.test/mcp" },
  },
  connections: [{ connectionId: "literature", capabilities: ["search"] }],
  subagents: { critic: { prompt: "Find confounds." } },
  resources: {
    files: [
      {
        path: "inputs/protocol.txt",
        resource: { kind: "inline", name: "protocol", content: "falsify" },
      },
    ],
    tools: [{ kind: "inline", name: "tool", content: "tool" }],
    skills: [{ kind: "inline", name: "skill", content: "skill" }],
    agents: [{ kind: "inline", name: "agent", content: "agent" }],
    commands: [{ kind: "inline", name: "command", content: "command" }],
    instructions: "Read every observation.",
    failOnError: false,
  },
  hooks: { afterTool: [{ command: "./capture-result" }] },
  modes: { adversarial: { prompt: "Try to falsify the claim." } },
  confidential: { sealed: true },
  metadata: { role: "driver" },
  extensions: { codex: { sandbox: "workspace-write" } },
};

function coverage(
  profile: AgentProfile,
  overrides: Partial<AgentExecutionPreparationAxisResult> = {},
): AgentExecutionPreparationAxisResult[] {
  return profileMaterializationRequests(profile).map(({ axis, path }) => ({
    axis,
    path,
    disposition: "behavior",
    owner: "executor",
    mechanism: "prepared-profile",
    ...overrides,
  }));
}

const workerProfile: AgentProfile = {
  name: "worker",
  model: {
    default: "openai/gpt-5.4",
    provider: "openai",
    reasoningEffort: "high",
  },
  harness: "codex",
  tools: { shell: true, web: false },
};

function buildReceipt(options: {
  authoredProfile?: AgentProfile;
  effectiveProfile?: AgentProfile;
  axisResults?: readonly AgentExecutionPreparationAxisResult[];
  reasoningEffort?: {
    requested: "high";
    resolved?: "high" | "medium";
    fidelity: "exact" | "clamped" | "unsupported";
  };
  workspaceLease?: AgentWorkspaceSealedLeaseRecord;
  profileActivation?: Pick<AgentProfileActivationEvidence, "digest">;
  nowMs?: number;
} = {}): AgentExecutionPreparationReceipt {
  const authoredProfile = options.authoredProfile ?? workerProfile;
  const effectiveProfile = options.effectiveProfile ?? authoredProfile;
  return buildAgentExecutionPreparationReceipt({
    preparationId: "prep-1",
    requestDigest: sha("1"),
    authoredProfile,
    effectiveProfile,
    backend: "cli-bridge",
    harness: "codex",
    harnessVersion: "0.90.0",
    resolvedModel: {
      requested: effectiveProfile.model?.default ?? "openai/gpt-5.4",
      resolved: "gpt-5.4-2026-07-01",
      provider: effectiveProfile.model?.provider ?? "openai",
      reasoningEffort: options.reasoningEffort ?? {
        requested: "high",
        resolved: "high",
        fidelity: "exact",
      },
    },
    workspaceLease: options.workspaceLease ?? sealedWorkspaceLease(),
    profileActivation: options.profileActivation ?? { digest: sha("3") },
    axisResults: options.axisResults ?? coverage(authoredProfile),
    executionPlanDigest: sha("4"),
    materializer: { name: "agent-profile-materialize", version: "0.9.3" },
    expiresAtMs: 2_000,
    nowMs: options.nowMs ?? 1_000,
  });
}

/** The issue codes a build refusal reports, or none when the build succeeds. */
function refusalCodes(build: () => unknown): string[] {
  try {
    build();
    return [];
  } catch (error) {
    if (!(error instanceof AgentExecutionPreparationValidationError)) throw error;
    return error.issues.map((issue) => issue.code);
  }
}

describe("profile materialization leaves", () => {
  it("enumerates canonical leaves, including optional seat policy", () => {
    expect(AGENT_PROFILE_MATERIALIZATION_AXES).toHaveLength(34);
    expect(profileMaterializationAxes(fullProfile)).toEqual(
      AGENT_PROFILE_MATERIALIZATION_AXES.filter((axis) => axis !== "seats"),
    );
  });

  it.each([
    "maxVisibleOutputTokens",
    "maxReasoningTokens",
    "maxTotalOutputTokens",
  ] as const)("requires exact application coverage for %s", (field) => {
    const authoredProfile: AgentProfile = {
      name: "worker",
      model: { default: "openai/gpt-5.4", [field]: 1024 },
    };
    const path = `/model/${field}`;
    const axisResults = coverage(authoredProfile);
    expect(axisResults.some((result) => result.path === path)).toBe(true);
    expect(() => buildReceipt({ authoredProfile, axisResults })).not.toThrow();
    expect(() => buildReceipt({
      authoredProfile,
      axisResults: axisResults.filter((result) => result.path !== path),
    })).toThrow(/missing.*coverage/);
    expect(() => buildReceipt({
      authoredProfile,
      axisResults: axisResults.map((result) => result.path === path
        ? { ...result, disposition: "unsupported", reason: "backend cannot enforce this ceiling" }
        : result),
    })).toThrow(/unsupported/);
    expect(() => buildReceipt({
      authoredProfile,
      effectiveProfile: { ...authoredProfile, model: { default: "openai/gpt-5.4" } },
      axisResults,
    })).toThrow(/changed between authored and effective/);
  });

  it("expands compound axes into every exact requested JSON Pointer", () => {
    expect(
      profileMaterializationRequests({
        prompt: { instructions: ["first", "second"] },
        model: { metadata: { routing: { tier: "large" } } },
        tools: { "a/b~c": true, shell: true, web: false },
        resources: {
          files: [
            {
              path: "notes/a~b.txt",
              executable: false,
              resource: { kind: "inline", name: "a/b", content: "bytes" },
            },
          ],
        },
      }),
    ).toEqual([
      { axis: "instructions", path: "/prompt/instructions/0" },
      { axis: "instructions", path: "/prompt/instructions/1" },
      { axis: "modelMetadata", path: "/model/metadata/routing/tier" },
      { axis: "tools", path: "/tools/a~1b~0c" },
      { axis: "tools", path: "/tools/shell" },
      { axis: "tools", path: "/tools/web" },
      { axis: "files", path: "/resources/files/0/executable" },
      { axis: "files", path: "/resources/files/0/path" },
      { axis: "files", path: "/resources/files/0/resource/content" },
      { axis: "files", path: "/resources/files/0/resource/kind" },
      { axis: "files", path: "/resources/files/0/resource/name" },
    ]);
  });

  it("keeps every explicit empty, null, false, and zero request", () => {
    const profile: AgentProfile = {
      name: " ",
      tags: [],
      prompt: { systemPrompt: "", appendSystemPrompt: "", instructions: [] },
      tools: {},
      resources: { failOnError: false },
      metadata: {
        blank: "",
        empty: {},
        list: [],
        nil: null,
        retries: 0,
      },
    };

    expect(profileMaterializationAxes(profile)).toEqual([
      "name",
      "tags",
      "systemPrompt",
      "appendSystemPrompt",
      "instructions",
      "tools",
      "resourceFailOnError",
      "metadata",
    ]);
    expect(profileMaterializationRequests(profile)).toEqual([
      { axis: "name", path: "/name" },
      { axis: "tags", path: "/tags" },
      { axis: "systemPrompt", path: "/prompt/systemPrompt" },
      { axis: "appendSystemPrompt", path: "/prompt/appendSystemPrompt" },
      { axis: "instructions", path: "/prompt/instructions" },
      { axis: "tools", path: "/tools" },
      { axis: "resourceFailOnError", path: "/resources/failOnError" },
      { axis: "metadata", path: "/metadata/blank" },
      { axis: "metadata", path: "/metadata/empty" },
      { axis: "metadata", path: "/metadata/list" },
      { axis: "metadata", path: "/metadata/nil" },
      { axis: "metadata", path: "/metadata/retries" },
    ]);
  });

  it("keeps hostile own keys as exact paths with RFC 6901 escaping", () => {
    const profile = agentProfileSchema.parse(
      JSON.parse(`{
        "tools": {
          "/": false,
          "__proto__": false,
          "a/b~c": false,
          "constructor": false,
          "toString": false,
          "~": false
        },
        "metadata": {
          "/": 0,
          "__proto__": 0,
          "a/b~c": 0,
          "constructor": false,
          "toString": 0,
          "~": 0
        }
      }`),
    );

    expect(profileMaterializationRequests(profile)).toEqual([
      { axis: "tools", path: "/tools/~1" },
      { axis: "tools", path: "/tools/__proto__" },
      { axis: "tools", path: "/tools/a~1b~0c" },
      { axis: "tools", path: "/tools/constructor" },
      { axis: "tools", path: "/tools/toString" },
      { axis: "tools", path: "/tools/~0" },
      { axis: "metadata", path: "/metadata/~1" },
      { axis: "metadata", path: "/metadata/__proto__" },
      { axis: "metadata", path: "/metadata/a~1b~0c" },
      { axis: "metadata", path: "/metadata/constructor" },
      { axis: "metadata", path: "/metadata/toString" },
      { axis: "metadata", path: "/metadata/~0" },
    ]);
  });

  it("includes hostile own keys, false, and zero values in profile identity", () => {
    const absent: AgentProfile = { metadata: {} };
    const absentDigest = canonicalAgentProfileDigest(absent);
    const digests = ["__proto__", "constructor", "toString", "~", "/"].map(
      (key, index) => {
        const metadata: Record<string, unknown> = {};
        Object.defineProperty(metadata, key, {
          value: index % 2 === 0 ? false : 0,
          enumerable: true,
        });
        return canonicalAgentProfileDigest({ metadata });
      },
    );

    expect(new Set(digests).size).toBe(5);
    expect(digests).not.toContain(absentDigest);
  });

  it("rejects malformed-Unicode record keys and sparse metadata arrays", () => {
    const malformedKey = String.fromCharCode(0xd800);
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, malformedKey, {
      value: 0,
      enumerable: true,
    });
    expect(() => canonicalAgentProfileDigest({ metadata })).toThrow(
      /valid Unicode/,
    );

    const sparse = Array<unknown>(2);
    sparse[1] = 0;
    expect(() => canonicalAgentProfileDigest({ metadata: { sparse } })).toThrow(
      /sparse array hole/,
    );
  });

  it("tags secret-capable config while preserving arbitrary public research text", () => {
    const profile: AgentProfile = {
      mcp: {
        local: {
          command: "mcp-server",
          args: [
            defineAgentProfilePublicConfig("serve"),
            defineAgentProfileSecretRef("MCP_ARGUMENT", "raw"),
          ],
          env: {
            MCP_TOKEN: defineAgentProfileSecretRef("MCP_TOKEN", "raw"),
          },
        },
        remote: {
          url: "https://mcp.example.test",
          headers: {
            Authorization: defineAgentProfileSecretRef(
              "MCP_AUTHORIZATION",
              "bearer",
            ),
          },
        },
      },
      hooks: {
        beforeRun: [
          {
            command: "prepare",
            env: {
              HOOK_TOKEN: defineAgentProfileSecretRef("HOOK_TOKEN"),
            },
          },
        ],
      },
    };
    const changedReference: AgentProfile = {
      ...profile,
      mcp: {
        local: {
          command: "mcp-server",
          args: [
            defineAgentProfilePublicConfig("serve"),
            defineAgentProfileSecretRef("MCP_ARGUMENT", "raw"),
          ],
          env: {
            MCP_TOKEN: defineAgentProfileSecretRef("OTHER_MCP_TOKEN", "raw"),
          },
        },
        remote: {
          url: "https://mcp.example.test",
          headers: {
            Authorization: defineAgentProfileSecretRef(
              "MCP_AUTHORIZATION",
              "bearer",
            ),
          },
        },
      },
    };

    expect(canonicalAgentProfileDigest(profile)).not.toBe(
      canonicalAgentProfileDigest(changedReference),
    );
    expect(
      agentProfileSchema.safeParse({
        mcp: { local: { command: "mcp-server", env: { MCP_TOKEN: "raw" } } },
      }).success,
    ).toBe(false);
    const securityResearchProfile: AgentProfile = {
      prompt: { systemPrompt: "Explain why Bearer raw-credential is unsafe." },
      metadata: {
        example: { kind: "secret-ref", key: "Bearer raw-credential" },
        "Bearer raw-credential": "public example text",
      },
    };
    expect(canonicalAgentProfileDigest(securityResearchProfile)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );

    const referenceInSecretSlot: AgentProfile = {
      mcp: {
        local: {
          command: "mcp-server",
          env: {
            MCP_TOKEN: defineAgentProfileSecretRef("MCP_TOKEN_REFERENCE"),
          },
        },
      },
    };
    expect(canonicalAgentProfileDigest(referenceInSecretSlot)).not.toBe(
      canonicalAgentProfileDigest(profile),
    );
    expect(() =>
      canonicalAgentProfileDigest({
        mcp: {
          local: {
            command: "mcp-server",
            env: {
              MCP_TOKEN: defineAgentProfileSecretRef("Bearer raw-credential"),
            },
          },
        },
      }),
    ).toThrow("secret reference key must be a public non-credential identity");
  });
});

describe("AgentExecutionPreparationReceipt", () => {
  it("binds authored routing preferences and separately receipts execution overrides", () => {
    const authoredProfile: AgentProfile = {
      name: "worker",
      harness: "pi",
      model: {
        default: "tangle/glm-5.2",
        provider: "tangle-router",
      },
    };
    const harnessChanged: AgentProfile = {
      ...authoredProfile,
      harness: "codex",
    };
    const modelChanged: AgentProfile = {
      ...authoredProfile,
      model: {
        ...authoredProfile.model,
        default: "anthropic/claude-opus-4-1",
      },
    };
    const providerChanged: AgentProfile = {
      ...authoredProfile,
      model: {
        ...authoredProfile.model,
        provider: "anthropic",
      },
    };
    const authoredDigests = [
      authoredProfile,
      harnessChanged,
      modelChanged,
      providerChanged,
    ].map(canonicalAgentProfileDigest);
    expect(new Set(authoredDigests)).toHaveLength(4);

    const effectiveProfile: AgentProfile = {
      ...authoredProfile,
      harness: "codex",
      model: {
        default: "anthropic/claude-opus-4-1",
        provider: "anthropic",
      },
    };
    const overriddenAxes = new Set([
      "harness",
      "modelDefault",
      "modelProvider",
    ]);
    const receipt = buildReceipt({
      authoredProfile,
      effectiveProfile,
      axisResults: coverage(authoredProfile).map((result) =>
        overriddenAxes.has(result.axis)
          ? {
              ...result,
              disposition: "overridden" as const,
              reason: "execution request selected a different route",
            }
          : result,
      ),
    });

    expect(receipt.authoredProfileDigest).toBe(
      canonicalAgentProfileDigest(authoredProfile),
    );
    expect(receipt.effectiveProfileDigest).toBe(
      canonicalAgentProfileDigest(effectiveProfile),
    );
    expect(receipt.authoredProfileDigest).not.toBe(
      receipt.effectiveProfileDigest,
    );
    expect(receipt).toMatchObject({
      harness: "codex",
      resolvedModel: {
        requested: "anthropic/claude-opus-4-1",
        provider: "anthropic",
      },
    });
    expect(
      receipt.axisResults
        .filter((result) => result.disposition === "overridden")
        .map((result) => result.axis),
    ).toEqual(["modelDefault", "modelProvider", "harness"]);
  });

  it("builds from a sealed lease", () => {
    const receipt = buildReceipt();

    expect(agentExecutionPreparationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      kind: "agent-execution-preparation",
      schemaVersion: 1,
      backend: "cli-bridge",
      harness: "codex",
      workspace: {
        leaseId: "lease-1",
        provider: "agent-runtime/local-private-workspace",
        isolation: "per-run",
        sourceSnapshotDigest: sha("8"),
        sourceSnapshotPolicy,
        preparedWorkspaceDigest: sha("9"),
        profileActivationDigest: sha("3"),
      },
      materializer: {
        name: "agent-profile-materialize",
        version: "0.9.3",
      },
    });
    expect(receipt.axisResults.every((result) => result.path !== undefined)).toBe(
      true,
    );
    expect(receipt.executionPlanDigest).toBe(sha("4"));
    expect(receipt).not.toHaveProperty("executionPlan");
    expect(receipt.workspace).not.toHaveProperty("root");
    expect(receipt.workspace).not.toHaveProperty("ownerToken");
  });

  it("rejects missing and unrequested profile coverage", () => {
    const requested = coverage(workerProfile);
    expect(
      refusalCodes(() =>
        buildReceipt({
          axisResults: requested.filter((result) => result.path !== "/tools/shell"),
        }),
      ),
    ).toContain("missing-coverage");

    const extra: AgentExecutionPreparationAxisResult = {
      axis: "metadata",
      path: "/metadata/unrequested",
      disposition: "control",
      owner: "runtime",
      mechanism: "runtime-metadata",
    };
    expect(
      refusalCodes(() => buildReceipt({ axisResults: [...requested, extra] })),
    ).toContain("unrequested-coverage");
  });

  it("rejects duplicate and conflicting coverage after resolving an omitted path", () => {
    const requested = coverage(workerProfile);
    const name = requested.find((result) => result.axis === "name")!;
    const pathless = { ...name };
    delete pathless.path;
    expect(() => buildReceipt({ axisResults: [pathless, ...requested] })).toThrow(
      "duplicate profile axis/path result",
    );

    const conflictingPathless: AgentExecutionPreparationAxisResult = {
      ...pathless,
      disposition: "overridden",
      reason: "different value",
    };
    expect(() =>
      buildReceipt({ axisResults: [conflictingPathless, ...requested] }),
    ).toThrow("conflicting profile axis/path results");
  });

  it("refuses unsupported strict profiles and permits only explicit partial profiles", () => {
    const strictProfile: AgentProfile = { tools: { shell: true } };
    expect(() =>
      buildReceipt({
        authoredProfile: strictProfile,
        effectiveProfile: strictProfile,
        axisResults: coverage(strictProfile, {
          disposition: "unsupported",
          reason: "backend has no shell tool",
        }),
      }),
    ).toThrow(/did not explicitly set resources.failOnError=false/);

    const partialProfile: AgentProfile = {
      tools: { shell: true },
      resources: { failOnError: false },
    };
    const partialResults = coverage(partialProfile).map((result) =>
      result.axis === "tools"
        ? {
            ...result,
            disposition: "unsupported" as const,
            reason: "backend has no shell tool",
          }
        : result,
    );
    expect(() =>
      buildReceipt({
        authoredProfile: partialProfile,
        effectiveProfile: partialProfile,
        axisResults: partialResults,
      }),
    ).not.toThrow();
  });

  it("requires overrides when explicit empty values disappear", () => {
    const authoredProfile: AgentProfile = {
      prompt: { systemPrompt: "", instructions: [] },
      tools: {},
      metadata: { nil: null },
    };
    expect(() =>
      buildReceipt({
        authoredProfile,
        effectiveProfile: {},
        axisResults: coverage(authoredProfile),
      }),
    ).toThrow(/changed between authored and effective profiles/);

    expect(() =>
      buildReceipt({
        authoredProfile,
        effectiveProfile: {},
        axisResults: coverage(authoredProfile, {
          disposition: "overridden",
          reason: "executor removed the explicit value",
        }),
      }),
    ).not.toThrow();
  });

  it("preserves an explicit empty model request while recording its resolution", () => {
    const profile: AgentProfile = {
      model: { default: "", provider: "" },
    };
    const receipt = buildReceipt({
      authoredProfile: profile,
      effectiveProfile: profile,
      axisResults: coverage(profile),
    });

    expect(receipt.resolvedModel).toMatchObject({
      requested: "",
      resolved: "gpt-5.4-2026-07-01",
      provider: "",
    });
    expect(receipt.axisResults).toEqual([
      expect.objectContaining({
        axis: "modelDefault",
        path: "/model/default",
      }),
      expect.objectContaining({
        axis: "modelProvider",
        path: "/model/provider",
      }),
    ]);
  });

  it("enforces exact or downward-clamped reasoning fidelity", () => {
    expect(
      agentExecutionPreparationReasoningEffortSchema.safeParse({
        requested: "high",
        resolved: "medium",
        fidelity: "exact",
      }).success,
    ).toBe(false);
    expect(
      agentExecutionPreparationReasoningEffortSchema.safeParse({
        requested: "medium",
        resolved: "high",
        fidelity: "clamped",
      }).success,
    ).toBe(false);
    expect(
      agentExecutionPreparationReasoningEffortSchema.parse({
        requested: "high",
        resolved: "medium",
        fidelity: "clamped",
      }),
    ).toEqual({
      requested: "high",
      resolved: "medium",
      fidelity: "clamped",
    });
  });

  it("keeps launch arguments and recognized credentials out of public evidence", () => {
    expect(
      agentExecutionPreparationAxisResultSchema.safeParse({
        axis: "tools",
        disposition: "behavior",
        owner: "executor",
        mechanism: "node --inspect ./materialize.js",
        path: "/tools/shell",
      }).success,
    ).toBe(false);
    expect(
      agentExecutionPreparationAxisResultSchema.safeParse({
        axis: "tools",
        disposition: "behavior",
        owner: "executor",
        mechanism: "sk-12345678901",
        path: "/tools/shell",
      }).success,
    ).toBe(false);
    expect(
      agentExecutionPreparationAxisResultSchema.safeParse({
        axis: "tools",
        disposition: "unsupported",
        owner: "executor",
        mechanism: "prepared-profile",
        path: "/tools/shell",
        reason: "authorization failed: Bearer credential-value",
      }).success,
    ).toBe(false);
  });

  it("detects self-digest tampering", () => {
    const receipt = buildReceipt();
    expect(
      agentExecutionPreparationReceiptSchema.safeParse({
        ...receipt,
        backend: "different-backend",
      }).success,
    ).toBe(false);
  });

  it("refuses a preparation that outlives its lease", () => {
    expect(() =>
      buildReceipt({
        workspaceLease: sealedWorkspaceLease({ expiresAtMs: 1_500 }),
      }),
    ).toThrow(/cannot outlive its workspace lease/);
  });

  it("refuses an expired preparation before compute", () => {
    expect(refusalCodes(() => buildReceipt({ nowMs: 2_000 }))).toContain(
      "expired",
    );
  });

  it("binds the existing candidate activation evidence core without weakening it", () => {
    const candidateActivation: AgentCandidateProfileActivation = {
      kind: "agent-candidate-profile-activation",
      profilePlan: {
        kind: "agent-profile-workspace-plan",
        digest: sha("5"),
        material: {
          sourceProfileDigest: sha("6"),
          harness: "codex",
          files: [],
          env: {},
          flags: [],
          unsupported: [],
        },
        artifact: {
          encoding: "base64",
          content: "e30=",
          sha256: sha("5"),
          byteLength: 2,
        },
      },
      files: [],
      digest: sha("7"),
    };
    const shared: AgentProfileActivationEvidence = candidateActivation;

    expect(agentCandidateProfileActivationSchema.parse(candidateActivation)).toEqual(
      candidateActivation,
    );
    const profile: AgentProfile = {};
    const receipt = buildAgentExecutionPreparationReceipt({
      preparationId: "candidate-prep",
      requestDigest: sha("1"),
      authoredProfile: profile,
      effectiveProfile: profile,
      backend: "sealed-candidate-runtime",
      harness: "codex",
      harnessVersion: "1.0.0",
      resolvedModel: {
        requested: "openai/gpt-5.4",
        resolved: "gpt-5.4-2026-07-01",
      },
      workspaceLease: sealedWorkspaceLease({
        leaseId: "candidate-lease",
        profileActivationDigest: shared.digest,
      }),
      profileActivation: shared,
      axisResults: [],
      executionPlanDigest: sha("4"),
      materializer: { name: "candidate-materializer", version: "1.0.0" },
      expiresAtMs: 2_000,
      nowMs: 1_000,
    });
    expect(receipt.workspace.profileActivationDigest).toBe(
      candidateActivation.digest,
    );
  });
});
