---
"@tangle-network/agent-interface": minor
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-testkit": minor
---

Add provider-neutral durable run references, strictly validated capabilities and replayable event envelopes, scope-bound interaction acknowledgements, request-bound portable context transfer with enforced token limits and provider-confirmed fresh sessions, retry-safe native continuation, and recoverable workspace branching contracts.
Keep the original SDK adapter interaction method source-compatible and add a separate durable command method.

Add reusable conformance checks for detached competing-run isolation, every interaction acknowledgement outcome, real over-limit planning, cross-request rejection, context receipts, retry conflicts, continuation boundaries, workspace operation recovery, dependency-ordered cleanup, absent disabled operations, and combined operation/cleanup failures.

Add exact session and immutable execution control references to detached and reconstructed Tangle sessions, bind result, replay, and cancel to that exact execution, validate capability and Sandbox result data, omit disabled methods, adapt inclusive Sandbox replay to exclusive cursors, reject unproven or mismatched receipts without advancing local state, and fail explicitly for unsupported context inputs.
Pack and test the Tangle provider together with the interface, testkit, and public Sandbox 0.17.0 dependency.
