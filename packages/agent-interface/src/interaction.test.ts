import { describe, expect, it } from "vitest";
import type { AgentExecutionInput, SdkProviderAdapter } from "./index.js";

import {
  InteractionExecutionBindingSchema,
  InteractionAcknowledgementSchema,
  InteractionCapabilitiesSchema,
  InteractionFieldSchema,
  InteractionRequestSchema,
  InteractionResponseSchema,
  InteractionResponseCommandSchema,
  interactionResponseCommandDigest,
  interactionRequestDigest,
  permissionAnswerSpec,
  validateAndParseInteractionResponse,
  validateInteractionAnswer,
  validateInteractionResponse,
  type InteractionAnswerSpec,
  type InteractionAcknowledgementStatus,
  type InteractionExecutionBinding,
  type InteractionResponseCommand,
  type InteractionRequestMaterial,
} from "./interaction.js";

const exactExecutionBinding: InteractionExecutionBinding = {
  runId: "run-1",
  provider: "test-provider",
  environmentId: "environment-1",
  sessionId: "session-1",
  executionId: "execution-1",
};

const interactionExecutionInput: AgentExecutionInput = {
  systemPrompt: "system",
  interactionBinding: exactExecutionBinding,
};
void interactionExecutionInput;

const legacyInteractionResponder: NonNullable<
  SdkProviderAdapter["respondToInteraction"]
> = async (_response) => {};
const durableInteractionResponder: NonNullable<
  SdkProviderAdapter["respondToInteractionCommand"]
> = async (command) => ({
  operationId: command.operationId,
  binding: command.binding,
  commandDigest: command.commandDigest,
  status: "accepted",
});
void legacyInteractionResponder;
void durableInteractionResponder;

// @ts-expect-error Removed question adapters must stay outside the shared contract.
type RemovedQuestionAdapter = (typeof import("./interaction.js"))["questionAnswerSpec"];
// @ts-expect-error Removed question shapes must stay outside the shared contract.
type RemovedQuestionShape = (typeof import("./interaction.js"))["LegacyQuestion"];

const selectSpec = (overrides?: {
  allowCustom?: boolean;
  multi?: boolean;
}): InteractionAnswerSpec => ({
  fields: [
    {
      type: "select",
      name: "choice",
      label: "Pick one",
      required: true,
      multi: overrides?.multi,
      allowCustom: overrides?.allowCustom,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
});

function parseInteractionRequest(value: Record<string, unknown>) {
  const { requestDigest: _requestDigest, binding: suppliedBinding, ...rest } = value;
  const id = String(rest.id);
  const binding = suppliedBinding ?? {
    runId: "run-1",
    provider: "test-provider",
    environmentId: "environment-1",
    sessionId: "session-1",
    executionId: "execution-1",
    interactionId: id,
  };
  const material = { ...rest, binding } as InteractionRequestMaterial;
  return InteractionRequestSchema.parse({
    ...material,
    requestDigest: interactionRequestDigest(material),
  });
}

describe("interaction execution binding", () => {
  it("carries one exact provider-turn identity into execution input", () => {
    expect(InteractionExecutionBindingSchema.parse(exactExecutionBinding)).toEqual(
      exactExecutionBinding,
    );
  });

  it("rejects incomplete or interaction-specific coordinates", () => {
    const { executionId: _executionId, ...incomplete } = exactExecutionBinding;
    expect(InteractionExecutionBindingSchema.safeParse(incomplete).success).toBe(
      false,
    );
    expect(
      InteractionExecutionBindingSchema.safeParse({
        ...exactExecutionBinding,
        interactionId: "interaction-1",
      }).success,
    ).toBe(false);
  });
});

describe("select field schema", () => {
  it("accepts allowCustom on select fields", () => {
    const parsed = InteractionFieldSchema.parse({
      type: "select",
      name: "choice",
      label: "Pick one",
      allowCustom: true,
      options: [{ value: "a", label: "A" }],
    });
    expect(parsed).toMatchObject({ type: "select", allowCustom: true });
  });

  it("rejects unknown properties at every nested wire boundary", () => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "text",
        name: "choice",
        label: "Choice",
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      InteractionFieldSchema.parse({
        type: "select",
        name: "choice",
        label: "Choice",
        options: [{ value: "a", label: "A", unexpected: true }],
      }),
    ).toThrow();
    expect(() =>
      parseInteractionRequest({
        id: "interaction-1",
        kind: "permission",
        title: "Run?",
        subject: {
          type: "command",
          command: "echo ok",
          unexpected: true,
        },
        answerSpec: { fields: [] },
      }),
    ).toThrow();
  });

  it("rejects ambiguous options and invalid defaults", () => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "select",
        name: "choice",
        label: "Choice",
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "A again" },
        ],
      }),
    ).toThrow(/option values must be unique/);
    expect(() =>
      InteractionFieldSchema.parse({
        type: "select",
        name: "choice",
        label: "Choice",
        options: [{ value: "a", label: "A" }],
        default: ["missing"],
      }),
    ).toThrow(/unknown option/);
    expect(() =>
      InteractionFieldSchema.parse({
        type: "select",
        name: "choice",
        label: "Choice",
        options: [{ value: "a", label: "A" }],
        default: ["a", "a"],
        multi: true,
      }),
    ).toThrow(/default values must be unique/);
    expect(
      InteractionFieldSchema.parse({
        type: "select",
        name: "choice",
        label: "Choice",
        options: [{ value: "a", label: "A" }],
        default: ["write-in"],
        allowCustom: true,
      }),
    ).toMatchObject({ default: ["write-in"] });
  });
});

describe("free-text field schema", () => {
  it.each(["text", "secret"] as const)(
    "accepts a caller-defined maxLength on %s fields",
    (type) => {
      const parsed = InteractionFieldSchema.parse({
        type,
        name: "answer",
        label: "Answer",
        maxLength: 4096,
      });
      expect(parsed).toMatchObject({ type, maxLength: 4096 });
    },
  );

  it.each([0, -1, 1.5])("rejects invalid maxLength %s", (maxLength) => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "text",
        name: "answer",
        label: "Answer",
        maxLength,
      }),
    ).toThrow();
  });

  it("rejects a text default longer than maxLength", () => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "text",
        name: "answer",
        label: "Answer",
        maxLength: 3,
        default: "four",
      }),
    ).toThrow(/default exceeds maxLength/);
  });
});

describe("number field schema", () => {
  it("rejects inverted bounds", () => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "number",
        name: "count",
        label: "Count",
        min: 10,
        max: 1,
      }),
    ).toThrow(/max must be greater than or equal to min/);
  });

  it.each([
    { min: 10, default: 9 },
    { max: 10, default: 11 },
  ])("rejects a default outside its bounds", (bounds) => {
    expect(() =>
      InteractionFieldSchema.parse({
        type: "number",
        name: "count",
        label: "Count",
        ...bounds,
      }),
    ).toThrow(/number field default/);
  });
});

describe("validateInteractionAnswer select", () => {
  it("rejects out-of-options values when allowCustom is unset", () => {
    const result = validateInteractionAnswer(selectSpec(), { choice: ["write-in"] });
    expect(result).toEqual({
      ok: false,
      errors: ['field "choice" has invalid option "write-in"'],
    });
  });

  it("accepts declared options regardless of allowCustom", () => {
    expect(validateInteractionAnswer(selectSpec(), { choice: ["a"] })).toEqual({ ok: true });
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), { choice: ["b"] }),
    ).toEqual({ ok: true });
  });

  it("accepts a write-in value when allowCustom is true", () => {
    const result = validateInteractionAnswer(selectSpec({ allowCustom: true }), {
      choice: ["my own answer"],
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a mix of declared and write-in values on multi selects", () => {
    const result = validateInteractionAnswer(
      selectSpec({ allowCustom: true, multi: true }),
      { choice: ["a", "something else"] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects blank write-ins even when allowCustom is true", () => {
    const result = validateInteractionAnswer(selectSpec({ allowCustom: true }), {
      choice: ["   "],
    });
    expect(result).toEqual({
      ok: false,
      errors: ['field "choice" has blank write-in value'],
    });
  });

  it("still enforces single-value and required rules with allowCustom", () => {
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), {
        choice: ["x", "y"],
      }),
    ).toEqual({ ok: false, errors: ['field "choice" accepts a single value'] });
    expect(
      validateInteractionAnswer(selectSpec({ allowCustom: true }), { choice: [] }),
    ).toEqual({ ok: false, errors: ['field "choice" requires a selection'] });
  });

  it("rejects undeclared answer fields", () => {
    expect(
      validateInteractionAnswer(selectSpec(), {
        choice: ["a"],
        adminOverride: true,
      }),
    ).toEqual({
      ok: false,
      errors: ['unknown field "adminOverride"'],
    });
  });
});

describe("validateInteractionAnswer number", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite value %s",
    (value) => {
      expect(
        validateInteractionAnswer(
          {
            fields: [
              {
                type: "number",
                name: "count",
                label: "Count",
              },
            ],
          },
          { count: value },
        ),
      ).toEqual({
        ok: false,
        errors: ['field "count" must be a finite number'],
      });
    },
  );
});

describe("validateInteractionAnswer free text", () => {
  it.each(["text", "secret"] as const)(
    "enforces the caller-defined maxLength on %s answers",
    (type) => {
      const spec: InteractionAnswerSpec = {
        fields: [{ type, name: "answer", label: "Answer", maxLength: 3 }],
      };
      expect(validateInteractionAnswer(spec, { answer: "yes" })).toEqual({ ok: true });
      expect(validateInteractionAnswer(spec, { answer: "four" })).toEqual({
        ok: false,
        errors: ['field "answer" exceeds maxLength 3'],
      });
    },
  );
});

const responseCommandMaterial = {
  operationId: "operation-1",
  binding: {
    runId: "run-1",
    provider: "test-provider",
    environmentId: "environment-1",
    sessionId: "session-1",
    executionId: "execution-1",
    interactionId: "interaction-1",
    requestDigest: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
  },
  response: {
    id: "interaction-1",
    outcome: "accepted" as const,
    data: { choice: ["a"] },
  },
};
const responseCommand: InteractionResponseCommand = {
  ...responseCommandMaterial,
  commandDigest: interactionResponseCommandDigest(responseCommandMaterial),
};

describe("interaction capabilities", () => {
  it("validates negotiated kinds, answer fields, scopes, and delivery behavior", () => {
    expect(
      InteractionCapabilitiesSchema.parse({
        kinds: ["question", "permission", "plan"],
        answerFieldTypes: ["text", "select", "secret"],
        responseScopes: ["interaction", "session", "persistent"],
        secretAnswers: true,
        concurrentRequests: true,
        replay: true,
        responseIdempotency: true,
      }),
    ).toMatchObject({ replay: true, responseIdempotency: true });
  });

  it("rejects contradictory secret support and duplicate capabilities", () => {
    expect(() =>
      InteractionCapabilitiesSchema.parse({
        kinds: ["question", "question"],
        answerFieldTypes: ["text", "secret"],
        responseScopes: ["interaction"],
        secretAnswers: false,
        concurrentRequests: false,
        replay: false,
        responseIdempotency: false,
      }),
    ).toThrow();
  });
});

describe("interaction response command", () => {
  it("binds the response to run, environment, session, and interaction", () => {
    expect(InteractionResponseCommandSchema.parse(responseCommand)).toEqual(
      responseCommand,
    );
  });

  it("rejects a response id that differs from its interaction binding", () => {
    expect(() =>
      InteractionResponseCommandSchema.parse({
        ...responseCommand,
        response: { ...responseCommand.response, id: "interaction-2" },
      }),
    ).toThrow(/must match/);
  });

  it("rejects changed response data under the same command identity", () => {
    expect(() =>
      InteractionResponseCommandSchema.parse({
        ...responseCommand,
        response: { ...responseCommand.response, data: { choice: ["b"] } },
      }),
    ).toThrow(/command digest/);
  });

  it("preserves declined and cancelled response data for wire compatibility", () => {
    for (const outcome of ["declined", "cancelled"] as const) {
      expect(
        InteractionResponseSchema.parse({
          id: "interaction-1",
          outcome,
          data: { reason: "legacy client payload" },
        }),
      ).toEqual({
        id: "interaction-1",
        outcome,
        data: { reason: "legacy client payload" },
      });
    }
  });

  it("rejects secret values on declined and cancelled resolutions", () => {
    const request = parseInteractionRequest({
      id: "secret-response-1",
      kind: "question",
      title: "Token",
      answerSpec: {
        fields: [
          {
            type: "secret",
            name: "token",
            label: "Token",
            required: false,
          },
        ],
      },
    });
    for (const outcome of ["declined", "cancelled"] as const) {
      const result = validateInteractionResponse(request, {
        id: request.id,
        outcome,
        data: { token: "must-not-leak" },
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.errors).toContain(
          `field "token" is secret and cannot ride a ${outcome} resolution`,
        );
      }
    }
  });

  it("returns parsed response data and rejects prototype keys", () => {
    const request = parseInteractionRequest({
      id: "safe-response-1",
      kind: "question",
      title: "Confirm",
      answerSpec: {
        fields: [{ type: "text", name: "answer", label: "Answer" }],
      },
    });
    const parsed = validateAndParseInteractionResponse(request, {
      id: request.id,
      outcome: "accepted",
      data: { answer: "yes" },
    });
    expect(parsed).toEqual({
      ok: true,
      response: {
        id: request.id,
        outcome: "accepted",
        data: { answer: "yes" },
      },
    });
    expect(
      Object.getOwnPropertyNames(parsed.ok ? parsed.response.data ?? {} : {}),
    ).not.toEqual(expect.arrayContaining(["__proto__", "constructor", "prototype"]));

    const payload = JSON.parse(
      `{"id":"${request.id}","outcome":"accepted","data":{"answer":"yes","__proto__":"polluted","constructor":"polluted","prototype":"polluted"}}`,
    );
    const rejected = validateInteractionResponse(request, payload);
    expect(rejected).toMatchObject({ ok: false });
    if (!rejected.ok) {
      expect(rejected.errors).toEqual(
        expect.arrayContaining([
          'unknown field "__proto__"',
          'unknown field "constructor"',
          'unknown field "prototype"',
        ]),
      );
    }
  });
});

describe("permission response scopes", () => {
  const request = parseInteractionRequest({
    id: "permission-1",
    kind: "permission",
    title: "Run command?",
    answerSpec: permissionAnswerSpec({
      responseScopes: ["interaction", "session", "persistent"],
    }),
    responseScopes: ["interaction"],
  });

  it("offers only grants enabled by the requested scopes", () => {
    const spec = permissionAnswerSpec({ responseScopes: ["interaction"] });
    expect(spec.fields[0]).toMatchObject({
      type: "select",
      options: [
        { value: "allow_once", label: "Allow once" },
        { value: "deny", label: "Deny" },
      ],
    });
  });

  it("always permits denial even when one-time approval is not offered", () => {
    const sessionRequest = parseInteractionRequest({
      id: "permission-session",
      kind: "permission",
      title: "Run command?",
      answerSpec: permissionAnswerSpec({ responseScopes: ["session"] }),
      responseScopes: ["session"],
    });

    expect(
      validateInteractionResponse(sessionRequest, {
        id: sessionRequest.id,
        outcome: "accepted",
        data: { grant: ["deny"] },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a persistent grant on an interaction-scoped request", () => {
    expect(
      validateInteractionResponse(request, {
        id: request.id,
        outcome: "accepted",
        data: { grant: ["allow_always"] },
      }),
    ).toEqual({
      ok: false,
      errors: [
        'permission grant "allow_always" exceeds the request\'s response scopes',
      ],
    });
    expect(
      validateInteractionResponse(request, {
        id: request.id,
        outcome: "accepted",
        data: { grant: ["allow_once"] },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an invalid default before the request is emitted", () => {
    expect(() =>
      parseInteractionRequest({
        ...request,
        onTimeout: "default",
        default: {
          outcome: "accepted",
          data: { grant: ["allow_always"] },
        },
      }),
    ).toThrow(/exceeds/);
  });
});

describe("secret interaction defaults", () => {
  it.each(["accepted", "declined", "cancelled"] as const)(
    "rejects secret values embedded in a persisted %s request",
    (outcome) => {
      expect(() =>
        parseInteractionRequest({
          id: "secret-1",
          kind: "question",
          title: "Token",
          answerSpec: {
            fields: [
              {
                type: "secret",
                name: "token",
                label: "Token",
                required: true,
              },
            ],
          },
          default: {
            outcome,
            data: { token: "must-not-be-persisted" },
          },
        }),
      ).toThrow(/secret answers cannot be embedded/);
    },
  );
});

describe("interaction acknowledgement", () => {
  const statuses: InteractionAcknowledgementStatus[] = [
    "accepted",
    "already_resolved_same",
    "already_resolved_different",
    "expired",
    "cancelled",
    "unknown_interaction",
    "unknown_run",
    "binding_mismatch",
    "invalid_response",
    "transport_failure",
  ];

  it.each(statuses)("validates the %s outcome", (status) => {
    const acknowledgement = {
      operationId: responseCommand.operationId,
      binding: responseCommand.binding,
      commandDigest: responseCommand.commandDigest,
      status,
      ...(["invalid_response", "transport_failure"].includes(status)
        ? { message: "connection closed", retryable: true }
        : {}),
    };
    expect(InteractionAcknowledgementSchema.parse(acknowledgement)).toEqual(
      acknowledgement,
    );
  });

  it("requires transport failure detail", () => {
    const common = {
      operationId: responseCommand.operationId,
      binding: responseCommand.binding,
      commandDigest: responseCommand.commandDigest,
    };
    expect(() =>
      InteractionAcknowledgementSchema.parse({
        ...common,
        status: "transport_failure",
      }),
    ).toThrow(/must include a message/);
    expect(() =>
      InteractionAcknowledgementSchema.parse({
        ...common,
        status: "invalid_response",
      }),
    ).toThrow(/must include a message/);
    expect(() =>
      InteractionAcknowledgementSchema.parse({
        ...common,
        status: "transport_failure",
        message: "connection closed",
      }),
    ).toThrow(/must state whether retry is safe/);
  });
});
