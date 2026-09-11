---
"@tangle-network/agent-provider-tangle": patch
"@tangle-network/agent-provider-cli-bridge": patch
---

Require an `@tangle-network/agent-interface` that bounds a turn prompt as content.

Both packages validate a turn with `AgentTurnInputSchema`, so the agent-interface copy each one
resolves decides what a turn may contain — not the copy the consumer installed at its own top level.
agent-interface 2.7.0 moved every `prompt` field off the 16 KiB metadata bound onto the 1 MiB content
bound, and 2.8.0 made the contract bound constants public. The Tangle provider still declared `^2.6.1`
and the CLI bridge `^2.4.0`, so a consumer whose lockfile already held an older entry kept validating
turns against the metadata bound on a stack whose manifests said the bug was fixed.

The Tangle provider now requires `^2.8.0`, because it also imports the contract bounds that became
public there. The CLI bridge requires `^2.7.0`, the release that changed the bound it validates with.
`resolved-interface-floor.test.ts` fails when the Tangle provider resolves an agent-interface below
its declared floor, when the declared floor is below the release its validation needs, or when the
resolved copy refuses a prompt larger than the metadata bound.
