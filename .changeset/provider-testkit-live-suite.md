---
"@tangle-network/agent-provider-testkit": minor
---

Add `runLiveProfileConformance`, which runs the requirements of SPEC.md against a real provider with a real profile (harness, model, system prompt, MCP server, hook, denied tool, subagent, mounted files) and reports every requirement id as pass, fail, skip or unproven. A missing credential skips the run with `no credential: <NAME>`; it never reports a pass. Remove the kit's own fake-backed tests.
