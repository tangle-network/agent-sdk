import { randomBytes } from "node:crypto";
import { harnessSystemPromptIntents, type AgentProfile, type HarnessType } from "@tangle-network/agent-interface";

/** A stdio MCP server in plain Node: `probe_record` appends its arguments to `mcp-calls.log`. */
export const mcpServerSource = (logPath: string): string => `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
  } else if (request.method === "tools/list") {
    send({ id: request.id, result: { tools: [{ name: "probe_record", description: "Record a value for the conformance run.", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] } });
  } else if (request.method === "tools/call") {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(request.params?.arguments ?? {}) + "\\n");
    send({ id: request.id, result: { content: [{ type: "text", text: "recorded" }] } });
  } else if (request.id !== undefined) {
    send({ id: request.id, result: {} });
  }
});
`;

export interface ProbeNonces {
  system: string;
  mcp: string;
  hook: string;
  child: string;
  canary: string;
  shell: string;
}

export function freshNonces(): ProbeNonces {
  const token = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;
  return { system: token("SYS"), mcp: token("MCP"), hook: token("HOOK"), child: token("CHILD"), canary: token("canary"), shell: token("shell") };
}

/** Absolute and per run, so the probes read the same file whatever directory the harness runs in. */
export const mcpLog = (runTag: string): string => `/tmp/${runTag}-mcp-calls.log`;
export const hookLog = (runTag: string): string => `/tmp/${runTag}-hook-marker.log`;
/** The probe MCP server is written here by the suite, because a profile may not carry source code as public config. */
export const mcpServerPath = (runTag: string): string => `/tmp/${runTag}-probe-mcp.mjs`;
export const deniedFile = (runTag: string): string => `/tmp/${runTag}-denied.txt`;

/**
 * The axis probe profile: one profile that exercises the system prompt, an MCP
 * server, a hook, a denied tool, a subagent and mounted files, each with a
 * nonce only that axis can reveal.
 */
export function probeProfile(harness: HarnessType, model: string, nonces: ProbeNonces, runTag: string): AgentProfile {
  const intents = harnessSystemPromptIntents(harness);
  const note = `Conformance nonce ${nonces.system}. When asked for the conformance nonce, reply with exactly that token and nothing else.`;
  return {
    name: `live-conformance-${runTag}`,
    description: "Live profile-execution conformance probe",
    version: "1",
    tags: ["conformance"],
    metadata: { conformanceRun: runTag },
    harness,
    model: { default: model },
    prompt: intents.append ? { appendSystemPrompt: note } : intents.replace ? { systemPrompt: note } : {},
    permissions: {
      Write: "deny",
      Task: "allow",
      Bash: { "*": "allow", "echo *": "deny", "tee *": "deny", "touch *": "deny", "printf *": "deny" },
    },
    mcp: { probe: { command: "node", args: [{ kind: "public", value: mcpServerPath(runTag) }] } },
    hooks: { PostToolUse: [{ matcher: "Bash", command: `sh -c "printf '%s\\n' ${nonces.hook} >> ${hookLog(runTag)}"`, timeoutMs: 10_000 }] },
    subagents: {
      "probe-child": {
        description: "Answers with the child code. Use it when asked to delegate to probe-child.",
        prompt: `Reply with exactly this token and nothing else: ${nonces.child}`,
      },
    },
    resources: {
      files: [
        { path: "probe-tool.sh", executable: true, resource: { kind: "inline", name: "probe-tool.sh", content: `#!/bin/sh\necho ${nonces.shell}\n` } },
      ],
    },
  };
}

/** The scripted tasks, one per axis. Each is a request the profile's own controls decide. */
export function probeTasks(nonces: ProbeNonces, runTag: string): Record<"system" | "mcp" | "hook" | "deny" | "subagent", string> {
  return {
    system: "What is the conformance nonce? Reply with only the nonce.",
    mcp: `Call the probe_record tool from the probe MCP server with value "${nonces.mcp}", then reply with exactly DONE.`,
    hook: "Run the shell command `pwd` with your Bash tool, then reply with exactly DONE.",
    deny: `Use the Write tool to create the file ${deniedFile(runTag)} containing the word x. If the tool is refused, reply with exactly DENIED and do not try any other way to create the file.`,
    subagent: "Delegate to the probe-child subagent with your Task tool, then reply with exactly what it returned.",
  };
}
