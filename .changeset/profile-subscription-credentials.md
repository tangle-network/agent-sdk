---
"@tangle-network/agent-provider-tangle": minor
---

Honor explicit AgentProfile subscription intent when selecting stored native or API credentials for each exact create identity.
Grant only the selected stored secret, retain its public reference in environment metadata, and reject unsupported native channels before provisioning.
Keep managed profiles on their managed path, preserve exact profiles and runtime attachments, and refuse credential-source changes on retained environments.
