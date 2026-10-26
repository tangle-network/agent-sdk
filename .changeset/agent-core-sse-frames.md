---
"@tangle-network/agent-core": minor
---

`@tangle-network/agent-core/sse` is now the one SSE wire-format implementation. It adds the WHATWG frame layer that agent-container's private `sse-core` package carried: `SSEFrameParser`, `streamSSEFrames` (abort signal, idle timeout via `SSEStreamSilentError`, body cancel on early return), `encodeSSEFrame`, and the `SSEFrame` and `SSEStreamOptions` types. `SSEChunkParser` now frames through `SSEFrameParser`, so it also strips a leading BOM and keeps no chunk alive through the event names and ids a consumer retains. An empty `event:` or `id:` value now reads as `undefined` rather than `""`. The subpath still imports nothing.
