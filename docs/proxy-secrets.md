# Proxy-held secrets

Tangle uses the Sandbox SDK's stored-secret host binding. Create the value through `client.secrets.create(name, value)` on the trusted host, then pass `secrets: [{name, host, header: "Authorization"}]` to `provider.create()`. The environment receives a salted placeholder; iron-proxy substitutes the value only for the bound host and scrubs reflected responses.

`proxySecrets` in a profile or create input lowers to these same entries. Tangle accepts one exact FQDN, matching `envName` and `secretRef.key`, and bearer, basic or custom-header presentation. Methods, paths, query placement, JWT placeholders, aliases, multiple hosts and explicit grant expiry cannot be enforced by the served host binding and are refused. Store lifetime and rotation belong to the caller's secret manager. Read the installed Sandbox SDK `SecretBinding` contract for platform limits.

Bindings cannot shadow inline environment values or conflict with readable delivery under the same name. Custom create mappers must preserve their host selection. Reconnection preserves the original selection; changing bindings requires a new environment. Tangle does not require or fabricate a proxy-secret capability receipt. Live verification compares an upstream digest, the in-box placeholder shape and the scrubbed reflection, without logging any credential value.
