import type { ProxySecretReceipt } from "@tangle-network/agent-interface";

/** Control-plane peer metadata only; HTTP tests do not claim proxy/materializer enforcement. */
export const installedProxyReceipt: ProxySecretReceipt = {
  protocolVersion: 1,
  sandboxId: "sandbox-bindings",
  generation: 1,
  status: "installed",
  proxyAcknowledged: true,
  materializationAcknowledged: true,
  bindings: [{
    envName: "REPORTS_TOKEN",
    secretRef: { kind: "secret-ref", key: "REPORTS_TOKEN" },
    grant: {
      protocolVersion: 1,
      grantId: "fixture-report-grant",
      sandboxId: "sandbox-bindings",
      epoch: "fixture-epoch",
      identity: { tenantId: "fixture-owner", issuerId: "fixture-issuer", secretId: "fixture-report", revision: "1" },
      scope: { hosts: ["reports.example.com"] },
      presentation: { type: "bearer" },
      placeholderFormat: "opaque",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }],
};
