import { describe, expect, it } from "vitest";
import {
  CONTENT_COMPLETION_KEY,
  CONTENT_KEY_FIELD,
  CONTENT_KEYS,
  CONTENT_PROMPT_KEY,
  CONTENT_TOOL_ARGS_KEY,
  CONTENT_TOOL_NAME_KEY,
  CONTENT_TOOL_RESULT_KEY,
  classifyAgent,
  declaredTaskText,
  extractContent,
  hasContent,
  logRecordContentBag,
  resolveDeclaredIntent,
} from "../src/index.js";

// Drift guard for the content-key alias vocabulary. The api-layer re-export
// shim is exercised in products/intelligence/api; this suite binds to src so a
// mutation in content-attributes.ts is caught here, and it pins the structural
// invariants the module's own docstring promises (writer-key ↔ alias-table
// agreement, presence/extraction parity, fail-loud on empty) rather than
// re-checking per-agent resolution.

describe("content writer-key ↔ alias-table drift guard", () => {
  it("every named writer PRIMARY key is a recognized content key", () => {
    // The OpenCode exporter (and any future writer) emits under these constants.
    // If a writer key is not in CONTENT_KEYS, the producer would emit content the
    // reader cannot see — the exact drift this layer exists to prevent.
    for (const key of [
      CONTENT_PROMPT_KEY,
      CONTENT_COMPLETION_KEY,
      CONTENT_TOOL_NAME_KEY,
      CONTENT_TOOL_ARGS_KEY,
      CONTENT_TOOL_RESULT_KEY,
    ]) {
      expect(CONTENT_KEYS).toContain(key);
    }
  });

  it("each writer key maps to its expected normalized field", () => {
    expect(CONTENT_KEY_FIELD[CONTENT_PROMPT_KEY]).toBe("prompt");
    expect(CONTENT_KEY_FIELD[CONTENT_COMPLETION_KEY]).toBe("completion");
    expect(CONTENT_KEY_FIELD[CONTENT_TOOL_NAME_KEY]).toBe("toolName");
    expect(CONTENT_KEY_FIELD[CONTENT_TOOL_ARGS_KEY]).toBe("toolArgs");
    expect(CONTENT_KEY_FIELD[CONTENT_TOOL_RESULT_KEY]).toBe("toolResult");
  });

  it("CONTENT_KEYS is frozen and consistent with CONTENT_KEY_FIELD", () => {
    expect(Object.isFrozen(CONTENT_KEYS)).toBe(true);
    expect(Object.isFrozen(CONTENT_KEY_FIELD)).toBe(true);
    // Every presence key resolves to a known field, and vice versa — no key in
    // one table that the other doesn't know about.
    for (const key of CONTENT_KEYS) {
      expect(CONTENT_KEY_FIELD[key]).toBeTruthy();
    }
    expect(Object.keys(CONTENT_KEY_FIELD).sort()).toEqual(
      [...CONTENT_KEYS].sort(),
    );
  });

  it("a value emitted under a writer key round-trips through the reader", () => {
    // Writer emits under the PRIMARY key → reader extracts the right field.
    expect(extractContent({ [CONTENT_PROMPT_KEY]: "do X" }).prompt).toBe(
      "do X",
    );
    expect(
      extractContent({ [CONTENT_COMPLETION_KEY]: "did X" }).completion,
    ).toBe("did X");
    expect(extractContent({ [CONTENT_TOOL_NAME_KEY]: "bash" }).toolName).toBe(
      "bash",
    );
  });
});

describe("hasContent / extractContent presence parity", () => {
  it("hasContent is true exactly when extractContent finds a field", () => {
    const carrying = { [CONTENT_PROMPT_KEY]: "hello" };
    expect(hasContent(carrying)).toBe(true);
    expect(Object.keys(extractContent(carrying)).length).toBeGreaterThan(0);

    const empty = { "service.name": "claude-code", "x.unrelated": "meta" };
    expect(hasContent(empty)).toBe(false);
    expect(extractContent(empty)).toEqual({});
  });

  it("a blank/whitespace value is not content (fail-loud, no fabricated read)", () => {
    expect(hasContent({ [CONTENT_PROMPT_KEY]: "   " })).toBe(false);
    expect(extractContent({ [CONTENT_PROMPT_KEY]: "   " })).toEqual({});
    expect(
      extractContent({ [CONTENT_PROMPT_KEY]: 42 as unknown as string }),
    ).toEqual({});
  });

  it("null/undefined bags return empty, never throw or sentinel", () => {
    expect(hasContent(null)).toBe(false);
    expect(hasContent(undefined)).toBe(false);
    expect(extractContent(null)).toEqual({});
    expect(extractContent(undefined)).toEqual({});
  });
});

describe("logRecordContentBag", () => {
  it("surfaces a user_prompt body under the prompt alias", () => {
    const bag = logRecordContentBag(
      { "event.name": "claude_code.user_prompt" },
      "summarize the repo",
    );
    expect(extractContent(bag).prompt).toBe("summarize the repo");
  });

  it("does not treat a generic log body as content", () => {
    const bag = logRecordContentBag(
      { "event.name": "some.other.event" },
      "just a log line",
    );
    expect(hasContent(bag)).toBe(false);
  });

  it("never overwrites an attribute-carried prompt with the body", () => {
    const bag = logRecordContentBag(
      { "event.name": "codex.user_prompt", prompt: "attr prompt" },
      "body prompt",
    );
    expect(bag.prompt).toBe("attr prompt");
  });

  it("anchors the user_prompt namespace: a suffix-only event name is not a prompt event", () => {
    // 'not_a_user_prompt' / 'myapp_user_prompt' end in 'user_prompt' but are not
    // a namespaced *.user_prompt event — the body must NOT be promoted to prompt.
    const notPrompt = logRecordContentBag(
      { "event.name": "not_a_user_prompt" },
      "body text",
    );
    expect("prompt" in notPrompt).toBe(false);
    expect(hasContent(notPrompt)).toBe(false);

    // A genuinely namespaced event still promotes the body.
    const real = logRecordContentBag(
      { "event.name": "claude_code.user_prompt" },
      "body text",
    );
    expect(real.prompt).toBe("body text");
  });
});

describe("messages content honesty (no empty/arbitrary-object false positive)", () => {
  // An api_request_body whose body decodes to an empty or arbitrary object must
  // not be wrapped into a non-empty messages array — that would make hasContent
  // lie about a metadata-only row.
  const MESSAGES_KEY = "claude_code.api_request_body.body";

  it("an empty object body is not content", () => {
    expect(hasContent({ [MESSAGES_KEY]: {} })).toBe(false);
    expect(extractContent({ [MESSAGES_KEY]: {} })).toEqual({});
    expect(hasContent({ [MESSAGES_KEY]: "{}" })).toBe(false);
  });

  it("an arbitrary object with no message text is not content", () => {
    expect(hasContent({ [MESSAGES_KEY]: { foo: "bar" } })).toBe(false);
    expect(extractContent({ [MESSAGES_KEY]: { foo: "bar" } })).toEqual({});
  });

  it("a single message object WITH text is still content", () => {
    const body = { role: "user", content: "summarize the repo" };
    expect(hasContent({ [MESSAGES_KEY]: body })).toBe(true);
    expect(extractContent({ [MESSAGES_KEY]: body }).messages).toEqual([body]);
  });

  it("a populated messages array is content", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(hasContent({ [MESSAGES_KEY]: body })).toBe(true);
  });
});

describe("classifyAgent — exact identity, no substring guess", () => {
  it("classifies by namespaced key, then declared system, then allowlist", () => {
    expect(classifyAgent({ "claude_code.user_prompt.prompt": "x" })).toBe(
      "claude-code",
    );
    expect(classifyAgent({ "codex.user_prompt.prompt": "x" })).toBe("codex");
    expect(classifyAgent({ "message.part.text": "x" })).toBe("opencode");
    expect(classifyAgent({ "gen_ai.system": "OpenCode" })).toBe("opencode");
    expect(classifyAgent({ "service.name": "codex-cli" })).toBe("codex");
  });

  it("returns unknown for a lookalike service name (no mislabel)", () => {
    expect(classifyAgent({ "service.name": "claude-helper-bot" })).toBe(
      "unknown",
    );
    expect(classifyAgent({})).toBe("unknown");
    expect(classifyAgent(null)).toBe("unknown");
  });
});

describe("declared intent recovery", () => {
  it("reports the matched source key, prefers task over prompt", () => {
    const m = resolveDeclaredIntent({
      "tangle.task": "the real task",
      "gen_ai.prompt": "a prompt",
    });
    expect(m).toEqual({ text: "the real task", source: "tangle.task" });
  });

  it("recovers intent from the first user message of a messages body", () => {
    const m = resolveDeclaredIntent({
      "claude_code.api_request_body.body": JSON.stringify({
        messages: [
          { role: "system", content: "be helpful" },
          { role: "user", content: "fix the bug" },
        ],
      }),
    });
    expect(m).toEqual({ text: "fix the bug", source: "messages" });
  });

  it("never fabricates intent from an assistant completion alone", () => {
    expect(declaredTaskText({ completion: "I did the thing" })).toBeNull();
    expect(
      resolveDeclaredIntent({ [CONTENT_COMPLETION_KEY]: "I did it" }),
    ).toBeNull();
  });
});

describe("Claude Code list-of-blocks message content (the capture unlock)", () => {
  // Anthropic / Claude Code carry message content as an array of typed blocks:
  // content: [{ type: "text", text }, { type: "tool_use", … }]. Before the block
  // branch in readMessageText, a message whose content is that array was silently
  // invisible to content recovery — the exact gap that left Claude Code feeds
  // metadata-only. These pin that the block text is now both seen and read.
  const blockMessage = {
    role: "user",
    content: [
      { type: "text", text: "fix the failing test" },
      { type: "tool_use", name: "bash", input: { cmd: "ls" } },
    ],
  };

  it("hasContent is true for a single block-array message (was invisible)", () => {
    // `claude_code.api_request_body.body` is a messages-aliased key; the value is
    // a single message object whose content is the Anthropic block array.
    expect(
      hasContent({ "claude_code.api_request_body.body": blockMessage }),
    ).toBe(true);
  });

  it("recovers the concatenated text of the text blocks", () => {
    expect(declaredTaskText({ messages: [blockMessage] })).toContain(
      "fix the failing test",
    );
  });

  it("a block array with only non-text blocks carries no content", () => {
    const toolOnly = {
      role: "assistant",
      content: [{ type: "tool_use", name: "bash", input: {} }],
    };
    expect(hasContent({ "claude_code.api_request_body.body": toolOnly })).toBe(
      false,
    );
  });
});
