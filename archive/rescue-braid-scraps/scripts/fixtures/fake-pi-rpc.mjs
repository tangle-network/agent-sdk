#!/usr/bin/env node

import { readFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("pi 0.83.0-provider-contract\n");
  process.exit(0);
}
if (args[args.indexOf("--mode") + 1] !== "rpc") {
  process.stderr.write("fake Pi only supports --mode rpc\n");
  process.exit(2);
}

const interactionNonce = findInteractionNonce(args);
const sessionId = "provider-contract-pi-session";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let messageCount = 0;
let permissionNumber = 0;
let pendingPermission = null;

input.on("line", (line) => {
  const command = JSON.parse(line);
  switch (command.type) {
    case "prompt": {
      messageCount += 2;
      send({ id: command.id, type: "response", command: "prompt", success: true });
      send({ type: "session", id: sessionId });
      send({ type: "agent_start" });
      send({ type: "turn_start" });
      const prompt = typeof command.message === "string" ? command.message : "";
      if (prompt.includes("read tool")) {
        permissionNumber += 1;
        const id = `provider-permission-${permissionNumber}`;
        const token = `${interactionNonce}-${permissionNumber}`;
        pendingPermission = { id, token };
        send({
          type: "extension_ui_request",
          id,
          method: "select",
          title: `Permission: read [cli-bridge-marker:${token}]`,
          options: ["allow_once", "deny"],
        });
      } else {
        finishTurn("braid provider live.");
      }
      break;
    }
    case "extension_ui_response": {
      if (!pendingPermission || command.id !== pendingPermission.id) break;
      send({
        type: "extension_ui_request",
        id: "provider-permission-applied",
        method: "notify",
        message: `cli-bridge.permission-applied.v1:${pendingPermission.token}:${String(command.value)}`,
      });
      send({
        type: "tool_execution_start",
        toolCallId: "provider-read-call",
        toolName: "read",
        args: { path: "package.json" },
      });
      pendingPermission = null;
      finishTurn("provider permission resumed.");
      break;
    }
    case "get_state":
      send({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId, messageCount },
      });
      break;
    case "abort":
      send({ id: command.id, type: "response", command: "abort", success: true });
      break;
    case "steer":
      send({ id: command.id, type: "response", command: "steer", success: true });
      break;
  }
});

function finishTurn(text) {
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  send({ type: "turn_end", message: { usage: { input: 1, output: 1 } } });
  send({ type: "agent_end" });
  send({ type: "agent_settled" });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function findInteractionNonce(argv) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "--extension") continue;
    try {
      const source = readFileSync(argv[index + 1], "utf8");
      const nonce = source.match(/const bridgeNonce = ["']([^"']+)["']/u)?.[1];
      if (nonce) return nonce;
    } catch {
      // Other profile extensions need not be readable by this fixture.
    }
  }
  throw new Error("CLI Bridge did not attach its Pi interaction extension");
}
