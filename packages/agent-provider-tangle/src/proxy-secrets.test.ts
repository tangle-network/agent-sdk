import { describe, expect, it, vi } from "vitest";
import { createTangleProvider } from "./index.js";
import type { SandboxClientLike } from "./tangle-types.js";

const binding = {
  envName: "REPORTS_TOKEN",
  secretRef: { kind: "secret-ref" as const, key: "reports-access" },
  hosts: ["reports.example.com"], presentation: { type: "bearer" as const },
  methods: ["POST"], paths: ["/v1/events"], ttlSeconds: 300,
};
const profile = { name: "secure-reporter", harness: "opencode" as const, proxySecrets: [binding] };
const capability = {
  protocolVersion: 1 as const, presentations: ["bearer" as const],
  placeholderFormats: ["opaque" as const], enforcement: "exact" as const,
  transports: ["https:443" as const], lifecycle: true as const,
};
function setup() {
  const creates: unknown[] = [];
  const turns = vi.fn();
  let metadata: Record<string, unknown> | undefined;
  const box = {
    id: "proxy-box", status: "running", get metadata() { return metadata; },
    capabilities: async () => ({ proxySecrets: capability }),
    async *streamPrompt() { turns(); },
  };
  const client = {
    capabilities: async () => ({ proxySecrets: capability }),
    async create(options?: Parameters<SandboxClientLike["create"]>[0]) { creates.push(options); metadata = options?.metadata; return box; },
    async get() { return box; },
  };
  return { client, creates, turns, box };
}

describe("public provider proxy-secret custody", () => {
  it("forwards one canonical profile declaration without readable grants", async () => {
    const { client, creates } = setup();
    await createTangleProvider({ client }).create({ profile, secrets: [] });
    expect(creates[0]).toMatchObject({ proxySecrets: [binding], secrets: [], backend: { profile } });
  });

  it("refuses an old peer before subscription resolution or allocation", async () => {
    const { client, creates } = setup();
    const resolver = vi.fn(async () => ({ cliAuth: { account: "seat", secretEnv: "NATIVE_BUNDLE", format: "bundle" as const }, proxySecrets: [binding] }));
    const native = { ...profile, harness: "codex" as const, model: { metadata: { credentialSource: "subscription" } } };
    await expect(createTangleProvider({ client: { ...client, capabilities: undefined }, modelCredentials: resolver }).create({ profile: native }))
      .rejects.toThrow(/proxy.secret.*capabilit/i);
    expect(resolver).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

  it("rejects input/profile disagreement and raw aliases before allocation", async () => {
    const { client, creates } = setup();
    const provider = createTangleProvider({ client });
    await expect(provider.create({ profile, proxySecrets: [{ ...binding, hosts: ["other.example.com"] }] })).rejects.toThrow(/proxy.secret.*(differ|disagree)/i);
    await expect(provider.create({ profile, env: { REPORTS_TOKEN: "fixture" } })).rejects.toThrow(/proxy.secret.*(raw|readable|alias|shadow)/i);
    await expect(provider.create({ profile, secrets: ["reports-access"] })).rejects.toThrow(/proxy.secret.*(raw|readable|alias|shadow)/i);
    expect(creates).toEqual([]);
  });
});
