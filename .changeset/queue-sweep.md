---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-cli-bridge": patch
---

Environment lifetimes, deterministic credential/dispatch failures, and live OpenCode raw frames.

- `CreateAgentEnvironmentInput` gains optional `maxLifetimeMs` and `idleTimeoutMs` (#309). The Tangle provider validates whole seconds and maps them to the Sandbox create's `maxLifetimeSeconds`/`idleTimeoutSeconds`; a provider that cannot enforce a lifetime fails the create rather than dropping it. The bridge providers clamp a requested hard lifetime to the configured one and refuse an idle timeout (these sandboxes enforce a wall clock, not idleness).
- A credential command's deterministic binding refusals (`acct sandbox resolve`'s ResolutionError lines: seat conflicts, already-bound identities, unenrolled seats) now throw typed `model_credential_refused` naming the bounded reason, and every generic command failure carries the command's bounded last stderr line as `stderrTail` (#475) — a retry loop can finally see why.
- A dispatch that Sandbox answers with a different execution id throws `TangleDispatchExecutionChangedError` (`code: DISPATCH_EXECUTION_CHANGED`) naming the requested and returned ids, instead of a plain Error retried as transient (#475). Runtime pairing: classify `DISPATCH_EXECUTION_CHANGED` terminal.
- A session-bound stream treats a live `raw` frame's harness-native sessionID as backend content, like `session.updated`'s resume key; envelope positions the sidecar rewrites still compare (#328).

Also: failed upstream qualification checks retain bounded, scrubbed failing-test diagnostics before cohort cleanup and upload them as distinct `-failure` artifacts (#608); the README gains the published-adapter walkthrough and the third-party adapter boundary (#514).
