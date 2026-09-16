---
"@tangle-network/agent-provider-tangle": minor
---

A JSON bound refusal is a `JsonBoundError` — `name: "JsonBoundError"`, `code: "JSON_BOUND_VIOLATION"`, with the caller `label` and the whole `JsonBoundViolation` (rule, path, observed, limit) on the error — instead of a plain `Error` that only its message could describe.

The runtime that supervises these environments classifies a failed retained execution from the error's structure, never its message, because this package's messages are not a contract. A bound refusal therefore reached the run journal under the one name reserved for an execution nobody can observe — "requires reconciliation before replacement" — telling the operator to reconcile before retrying when nothing had run and nothing needed reconciling (agent-runtime#1204, exhibit 6: `mech-interp-foundations-glm2-b-20260912a`, 2026-09-12). With a stable `code` the runtime files it as a rejected request at admission or a provider contract violation after, and `disco report` shows which. Messages are unchanged; `JsonBoundError` and its types are exported.
