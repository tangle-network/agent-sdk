---
"@tangle-network/agent-interface": minor
---

Add measureAgentProfile for canonical declaration measurements: profile bytes, per-prompt and inline-resource bytes and lines, tool and MCP enablement counts, and subagent counts. External resource content, tokenization, materialization, and usage remain explicitly unmeasured. Consumers can cache these content-free measurements with existing profile records.
