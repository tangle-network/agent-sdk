import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Consume installed archives only. The HTTP peer admits public metadata, never issues credentials.
const require = createRequire(join(resolve(process.argv[2] ?? process.cwd()), "package.json"));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const root = await load("@tangle-network/agent-interface");
const environment = await load("@tangle-network/agent-interface/environment-provider");
const schemas = await load("@tangle-network/agent-interface/profile-schema");
const { z } = await load("zod");
for (const name of ["ProxySecretBindingSchema", "ProxySecretsSchema", "ProxySecretReceiptSchema", "ProxySecretCapabilitiesSchema"]) {
  assert.equal(root[name], environment[name], name);
  assert.equal(root[name], schemas[name], name);
}
assert.equal(root.intersectProxySecretScopes, environment.intersectProxySecretScopes);
const fixture = JSON.parse(readFileSync(new URL("../fixtures/proxy-secret-wire-v1.json", pathToFileURL(require.resolve("@tangle-network/agent-interface/profile-schema"))), "utf8"));
for (const entry of fixture.declarations) assert.equal(root.ProxySecretBindingSchema.safeParse(entry.value).success, entry.valid, entry.name);
const binding = fixture.declarations.find(entry => entry.valid).value;
const profile = schemas.agentProfileSchema.parse({ proxySecrets: [binding] });
assert.deepEqual(profile.proxySecrets, [binding]);
const changed = { proxySecrets: [{ ...binding, secretRef: { kind: "secret-ref", key: "different-approved-reference" } }] };
assert.notEqual(root.canonicalAgentProfileDigest(profile), root.canonicalAgentProfileDigest(changed));
assert.deepEqual(root.mergeProxySecretBindings([binding], [binding]), [binding]);
assert.throws(() => root.mergeProxySecretBindings([binding], changed.proxySecrets));
const envSchema = root.ownPropertyRecordSchema(z.string(), { maxEntries: Number.MAX_SAFE_INTEGER });
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const scope = root.intersectProxySecretScopes(input.left, input.right);
    if (!scope) { response.writeHead(403).end("{}"); return; }
    const env = envSchema.parse(input.env ?? {});
    const admitted = schemas.agentProfileSchema.parse({ proxySecrets: [{ ...binding, ...scope }] });
    const grant = root.ProxySecretGrantSchema.parse({ protocolVersion: 1, grantId: "grant-1", sandboxId: "box-1", epoch: "epoch-1", identity: { tenantId: "tenant-1", issuerId: "issuer-1", secretId: "secret-1", revision: "revision-1" }, scope, presentation: binding.presentation, placeholderFormat: "opaque", issuedAt: "2026-10-30T00:00:00.000Z", expiresAt: "2026-10-30T00:05:00.000Z" });
    assert.ok(root.isProxySecretScopeAttenuation(input.left, grant.scope));
    assert.ok(root.isProxySecretScopeAttenuation(input.right, grant.scope));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ scope, profile: admitted, grant, env, digest: root.canonicalAgentProfileDigest(admitted) }));
  } catch (error) { response.writeHead(error.name === "ZodError" ? 400 : 500).end("{}"); }
});
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const submit = input => fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", body: JSON.stringify(input) });
  for (const entry of fixture.scopeIntersections) {
    const response = await submit(entry);
    assert.equal(response.status, entry.result === null ? 403 : 200, entry.name);
    const output = await response.json();
    if (entry.result === null) { assert.equal(output.grant, undefined); continue; }
    assert.deepEqual(output.scope, entry.result, entry.name);
    assert.deepEqual(root.ProxySecretGrantSchema.parse(output.grant).scope, entry.result);
    assert.equal(root.canonicalAgentProfileDigest(schemas.agentProfileSchema.parse(output.profile)), output.digest);
  }
  const env = Object.fromEntries([...Array.from({ length: 300 }, (_, i) => [`LEGACY_${i}`, "opaque-fixture"]), ["__proto__", "opaque-fixture"], ["constructor", "opaque-fixture"], ["prototype", "opaque-fixture"]]);
  const scope = { hosts: binding.hosts };
  const response = await submit({ left: scope, right: scope, env });
  assert.equal(response.status, 200);
  const restored = (await response.json()).env;
  assert.deepEqual(restored, env);
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  const invalid = await submit({ left: scope, right: scope, env: JSON.parse('{"__proto__":17}') });
  assert.equal(invalid.status, 400);
  console.log(JSON.stringify({ packedPublicScopeAdmission: true, httpCases: fixture.scopeIntersections.length + 2, scopeIntersections: fixture.scopeIntersections.length, legacyRecordEntries: Object.keys(env).length, prototypeKeysRetained: true, metadataOnly: true }));
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
