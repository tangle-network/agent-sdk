import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

describe("createCliBridgeProvider", () => {
  it("streams OpenAI chunks as provider events", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          [
            ": connected\n\n",
            'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", prompt: { systemPrompt: "system" } },
      backend: "codex",
      workspace: { cwd: "/workspace" },
    });

    const events = [];
    for await (const event of environment.stream({ prompt: "go", sessionId: "s1" })) events.push(event);

    expect(body).toMatchObject({
      model: "codex",
      session_id: "s1",
      cwd: "/workspace",
    });
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "usage",
      "message.part.updated",
      "result",
    ]);
    expect(events.at(-1)).toMatchObject({ data: { finalText: "hello" } });
  });
});
