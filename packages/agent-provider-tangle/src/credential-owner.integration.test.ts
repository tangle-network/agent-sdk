import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "@tangle-network/sandbox";
import { afterEach, expect, it } from "vitest";
import { createTangleProvider, TangleCredentialCommandError } from "./index.js";
import { createCommandModelCredentialResolver, createHttpModelCredentialResolver } from "./node.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const profile = { name:"subscription",harness:"claude-code" as const,model:{provider:"anthropic",default:"owner-model",metadata:{credentialSource:"subscription"}} };
const input = {profile,idempotencyKey:"run:worker"};
const refusal = {error:{code:"model_credential_refused",reason:"unsupported_route"}};
const reference = {cliAuth:{account:"owner-account",secretEnv:"OWNER_REFERENCE",format:"token" as const}};
async function processFixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(),"credential-owner-"));
  cleanups.push(() => rm(directory,{recursive:true,force:true}));
  const script = join(directory,"owner.mjs");
  await writeFile(script,source);
  return {directory,command:[process.execPath,script]};
}
async function peer() {
  const requests: Array<{path:string;body:unknown}> = [];
  const server = createServer(async (request,response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = new URL(request.url!,"http://peer").pathname;
    requests.push({path,body:JSON.parse(Buffer.concat(chunks).toString() || "{}")});
    response.setHeader("content-type","application/json");
    response.statusCode = path === "/validate" ? 400 : path === "/resolve" ? 200 : 500;
    response.end(JSON.stringify(path === "/validate" ? {supported:false,...refusal} : reference));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  cleanups.push(() => new Promise<void>((resolve,reject) => { server.closeAllConnections();server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No peer address");
  return {baseUrl:`http://127.0.0.1:${address.port}`,requests};
}

it("uses the owner's read-only command at spawn preflight, without resolving or creating",async () => {
  const fixture = await processFixture(`import{writeFileSync}from'node:fs';let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
    if(!process.argv.includes('--validate-only'))throw new Error('must not select a seat');
    writeFileSync(process.env.RECEIPT,data);process.stdout.write(JSON.stringify(${JSON.stringify({supported:false,...refusal})}));process.exitCode=78;
  });`);
  const http = await peer();
  const receipt = join(fixture.directory,"validation.json");
  const resolver = createCommandModelCredentialResolver({...fixture,validationCommand:[...fixture.command,"--validate-only"],env:{RECEIPT:receipt}});
  const provider = createTangleProvider({client:new Sandbox({baseUrl:http.baseUrl,apiKey:"fixture-only"}),modelCredentials:resolver});
  await expect(provider.validateProfile!(profile)).resolves.toMatchObject({ok:false,issues:[{level:"error",code:"model_credential_refused"}]});
  expect(JSON.parse(await readFile(receipt,"utf8"))).toEqual({input:{profile,idempotencyKey:"profile-preflight"}});
  expect(http.requests).toEqual([]);
});

it("preserves a command's machine failure and discards its private diagnostics",async () => {
  const fixture = await processFixture("process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('private-fixture-value');process.exitCode=7;});");
  const error = await Promise.resolve(createCommandModelCredentialResolver(fixture)(input)).catch(error => error);
  expect(error).toBeInstanceOf(TangleCredentialCommandError);
  expect(error).toMatchObject({code:"credential_command_failed",exitCode:7,terminationSignal:null,failure:{kind:"infra",code:"credential_command_failed"}});
  expect(JSON.stringify(error)).not.toContain("private-fixture-value");
});

it("reads refreshed run authority on each call through one retained resolver",async () => {
  const fixture = await processFixture("import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end',()=>{ appendFileSync(process.env.RECEIPT,process.env.RUN_AUTHORITY+'\\n'); process.stdout.write(JSON.stringify({cliAuth:{account:'owner-account',secretEnv:'OWNER_REFERENCE',format:'token'}})); });");
  const receipt = join(fixture.directory,"authority.txt");
  let authority = "first-fixture-generation";
  const env = {RECEIPT:receipt,get RUN_AUTHORITY(){return authority;}};
  const resolver = createCommandModelCredentialResolver({...fixture,env});
  expect(await resolver(input)).toEqual(reference);
  authority = "replacement-fixture-generation";
  const selected = await resolver(input);
  expect(selected).toEqual(reference);
  expect((await readFile(receipt,"utf8")).trim().split("\n")).toEqual([
    "first-fixture-generation","replacement-fixture-generation",
  ]);
  expect(JSON.stringify(selected)).not.toContain(authority);
});

it("retains the owner's capacity reset without inventing an HTTP status",async () => {
  const resetAt = "2026-11-10T18:00:00.000Z";
  const fixture = await processFixture(`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({error:{code:'provider_quota_exhausted',reason:'exhausted',resetAt:${JSON.stringify(resetAt)}}}));process.exitCode=75;});`);
  const error = await Promise.resolve(createCommandModelCredentialResolver(fixture)(input)).catch(error => error);
  expect(error).toMatchObject({code:"provider_quota_exhausted",resetAt,failure:{kind:"capacity",code:"provider_quota_exhausted",resetAt}});
  expect(error).not.toHaveProperty("status");
});

it("validates through a separate HTTP route without resolving credentials or provisioning",async () => {
  const http = await peer();
  const resolver = createHttpModelCredentialResolver({url:`${http.baseUrl}/resolve`,validationUrl:`${http.baseUrl}/validate`,bearer:"fixture-narrow-grant".repeat(3)});
  const provider = createTangleProvider({client:new Sandbox({baseUrl:http.baseUrl,apiKey:"fixture-only"}),modelCredentials:resolver});
  await expect(provider.validateProfile!(profile)).resolves.toMatchObject({ok:false,issues:[{code:"model_credential_refused"}]});
  expect(http.requests.map(request => request.path)).toEqual(["/validate"]);
  expect(await resolver(input)).toEqual(reference);
  expect(http.requests.map(request => request.path)).toEqual(["/validate","/resolve"]);
});

it.each([75,78])("does not classify a refusal envelope under mismatched process exit %s",async exitCode => {
  const body = exitCode === 75 ? refusal : {error:{code:"provider_quota_exhausted",reason:"exhausted"}};
  const fixture = await processFixture(`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(${JSON.stringify(body)}));process.exitCode=${exitCode};});`);
  await expect(Promise.resolve(createCommandModelCredentialResolver(fixture)(input))).rejects.toMatchObject({code:"credential_command_failed",exitCode});
});

it("does not turn a capacity-exit validation reply into a permanent route refusal",async () => {
  const body = {supported:false,...refusal};
  const fixture = await processFixture(`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(${JSON.stringify(body)}));process.exitCode=75;});`);
  const resolver = createCommandModelCredentialResolver({...fixture,validationCommand:fixture.command});
  await expect(resolver.validate!(profile)).rejects.toMatchObject({code:"credential_command_failed",exitCode:75});
});

it.each(["Resume seat conflicts with the bound dispatch","already bound to a different profile","not enrolled for the exact stage profile"])("does not classify private diagnostic text as a public refusal: %s",async reason => {
  const fixture = await processFixture(`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(reason)});process.exitCode=1;});`);
  await expect(Promise.resolve(createCommandModelCredentialResolver(fixture)(input))).rejects.toMatchObject({code:"credential_command_failed",exitCode:1,failure:{kind:"infra",code:"credential_command_failed"}});
});

it.each([null,"caller cancelled",{code:"CALLER_CANCELLED"}])("preserves the HTTP caller's arbitrary abort reason %j and closes its response",async reason => {
  let open!: () => void, close!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const closed = new Promise<void>(resolve => { close = resolve; });
  const server = createServer((request,response) => {
    request.resume(); response.writeHead(200,{"content-type":"application/json"}); response.flushHeaders();
    response.on("close",close); open();
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections();server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No peer address");
  const resolver = createHttpModelCredentialResolver({url:`http://127.0.0.1:${address.port}/resolve`,bearer:"fixture-narrow-grant".repeat(3)});
  const controller = new AbortController();
  const outcome = Promise.resolve(resolver({...input,signal:controller.signal})).then(value => ({value}),error => ({error}));
  await opened; controller.abort(reason);
  const settled = await outcome;
  expect("error" in settled && settled.error === reason).toBe(true);
  await closed;
});
