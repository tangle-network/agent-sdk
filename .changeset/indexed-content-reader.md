---
"@tangle-network/agent-core": minor
---

telemetry: read indexed / array / tool-call trace content, and stop dropping the reply

`extractContent` / `hasContent` / `resolveDeclaredIntent` now reconstruct the
INDEXED / ARRAY / nested content shapes that push-OTLP providers emit — which the
flat alias table could not match, so `extractContent({"gen_ai.prompt.0.content":"hi"})`
previously returned `{}` and every downstream analysis went dark for the entire
push population:

- OpenInference (Phoenix, LangGraph, CrewAI, LlamaIndex): `llm.input_messages.{i}.message.content`, nested `…tool_calls.{j}.tool_call.function.arguments`
- OTel-GenAI flattened (LiteLLM, OpenAI Agents SDK, Pydantic, older OpenLLMetry): `gen_ai.prompt.{i}.content` / `gen_ai.completion.{i}.content`
- OTel-GenAI v1.28+ event arrays (Vercel AI SDK, current OpenLLMetry): `gen_ai.input.messages` / `gen_ai.output.messages`
- bare tool-call keys: `tool_call.function.arguments`

Reconstruction runs as a pure, non-destructive pre-pass (`normalizeContentAttributes`,
now exported) inside every read path, so a new provider's flattening is learned in
ONE place and all consumers read indexed content by construction.

Also fixes a latent reply-drop: both message arrays aliased the single `messages`
field (resolved once), so with a prompt present the assistant reply was silently
lost. The OUTPUT reply is now reconstructed into the SEPARATE `completion` field
(`llm.output_messages` is no longer a `messages` alias), so a full turn carries
BOTH the prompt and the reply.

New exports: `normalizeContentAttributes` and `INDEXED_CONTENT_KEY_LIKE_PATTERNS`
(SQL `LIKE` patterns for indexed-content detection, so a DB-side "content seen"
check reuses the same vocabulary as the in-process reader).
