---
"@tangle-network/agent-interface": patch
"@tangle-network/agent-provider-tangle": patch
---

Accept the Sandbox platform's strict-egress entry shape: `allowDomains` carries `string | { domain, allowPrivateIps: cidr[] }`, the provider forwards each entry unchanged, and its Sandbox SDK floor moves to 1.0.141, the first release that carries the shape.
