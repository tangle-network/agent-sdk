---
"@tangle-network/agent-interface": patch
---

Default the Tangle router to `zai/glm-5.2`, a model the router both routes and
holds a spend-authorizing price for. The previous default, `zai/glm-4.7`, is
not in the router catalog, so a managed run that named no model asked for a
model the router does not carry and received a 503 that a CLI retries until its
own timeout.
