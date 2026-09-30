import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandModelCredentialResolver } from "./node.js";
import { createTangleProvider } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function command(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "tangle-credential-command-"));
  directories.push(directory);
  const script = join(directory, "resolver.mjs");
  await writeFile(script, source);
  return { directory, command: [process.execPath, script] };
}
const input = { profile: { name: "researcher", harness: "claude-code" as const }, idempotencyKey: "runtime:root" };
const publicReference = { cliAuth: { account: "research", secretEnv: "CLAUDE_RESEARCH", format: "token" as const } };

describe("account-owned credential command transport", () => {
  it("forwards exact create identity and a fixed deadline through JSON stdin without a shell", async () => {
    const fixture = await command(`import { writeFileSync } from "node:fs";
let data = ""; process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => { writeFileSync(process.env.RECEIPT, data); process.stdout.write(JSON.stringify(${JSON.stringify(publicReference)})); });`);
    const receipt = join(fixture.directory, "request.json");
    const minimumValidUntil = "2026-10-01T06:00:00.000Z";
    const resolver = createCommandModelCredentialResolver({ ...fixture, env: { RECEIPT: receipt }, minimumValidUntil });
    const controller = new AbortController();
    expect(await resolver({ ...input, signal: controller.signal })).toEqual(publicReference);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ input, minimumValidUntil });
  });

  it("refuses missing identity before spawning the command", async () => {
    const fixture = await command(`process.stdout.write(JSON.stringify(${JSON.stringify(publicReference)}));`);
    const resolver = createCommandModelCredentialResolver(fixture);
    expect(() => resolver({ profile: input.profile })).toThrow(/idempotencyKey/);
  });

  it.each([
    'process.stderr.write("private-token-fixture"); process.exit(7);',
    'process.stdout.write("private-token-fixture");',
    'process.stdout.write(JSON.stringify({apiKey:"private-token-fixture"}));',
    'process.stdout.write("x".repeat(65537));',
  ])("refuses private or invalid output with zero provisioning and sanitized error", async (source) => {
    const fixture = await command(source);
    let creates = 0;
    const provider = createTangleProvider({
      client: { async create() { creates++; return { id: "unexpected", status: "running", capabilities: async () => ({ cliAuthReferences: true }), async *streamPrompt() {} }; } },
      modelCredentials: createCommandModelCredentialResolver(fixture),
    });
    const result = provider.create(input);
    await expect(result).rejects.toThrow(/Tangle credential command/);
    await expect(result).rejects.not.toThrow(/private-token-fixture/);
    expect(creates).toBe(0);
  });

  it("stops a stalled command at its timeout", async () => {
    const fixture = await command('setInterval(() => {}, 1000);');
    await expect(createCommandModelCredentialResolver({ ...fixture, timeoutMs: 50 })(input)).rejects.toThrow(/timed out/);
  });

  it("terminates the child on caller cancellation", async () => {
    const fixture = await command('setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const pending = createCommandModelCredentialResolver(fixture)({ ...input, signal: controller.signal });
    controller.abort(new Error("cancelled-fixture"));
    await expect(pending).rejects.toThrow("cancelled-fixture");
  });

  it("forwards identical immutable inputs across separate provider and command instances", async () => {
    const fixture = await command(`import { appendFileSync } from "node:fs"; let data = ""; process.stdin.on("data", chunk => data += chunk); process.stdin.on("end", () => { appendFileSync(process.env.RECEIPT, data); process.stdout.write(JSON.stringify(${JSON.stringify(publicReference)})); });`);
    const receipt = join(fixture.directory, "replays.jsonl");
    const deadline = "2026-10-01T06:00:00.000Z";
    const creates: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      const provider = createTangleProvider({
        client: { async create(options) { creates.push(options); return { id: "same-owner-binding", status: "running", capabilities: async () => ({ cliAuthReferences: true }), async *streamPrompt() {} }; } },
        modelCredentials: createCommandModelCredentialResolver({ ...fixture, env: { RECEIPT: receipt }, minimumValidUntil: deadline }),
      });
      await provider.create(input);
    }
    const requests = (await readFile(receipt, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(requests).toEqual([{ input, minimumValidUntil: deadline }, { input, minimumValidUntil: deadline }]);
    expect(creates[0]).toEqual(creates[1]);
  });

  it("keeps the owner exit code while discarding its private diagnostic", async () => {
    const fixture = await command('process.stderr.write("private-token-fixture"); process.exit(12);');
    await expect(createCommandModelCredentialResolver(fixture)(input)).rejects.toMatchObject({ exitCode: 12, message: "Tangle credential command failed (exit 12)" });
  });

  it("rejects conflicting validity controls", () => {
    expect(() => createCommandModelCredentialResolver({ command: [process.execPath], minimumValidityMs: 1000, minimumValidUntil: "2026-10-01T06:00:00.000Z" }))
      .toThrow(/one validity deadline/);
  });
});
