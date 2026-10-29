#!/usr/bin/python3
"""Existing OpenCode step receipts through the real Bridge producer."""
import json
import sys
if "--version" in sys.argv:
    print("opencode evidence fixture")
    raise SystemExit(0)
prompt = " ".join(sys.argv[1:]) + "\n" + sys.stdin.read()
if "evidence-case:" not in prompt:
    raise RuntimeError("actual OpenCode prompt did not bind an evidence case")
def send(value):
    print(json.dumps(value), flush=True)
send({"type": "text", "part": {"type": "text", "text": "incremental response"}})
first = {"output": 2, "reasoning": 0}
if "evidence-case:complete-deltas" in prompt:
    first.update({"input": 1, "cache": {"read": 0, "write": 0}})
send({"type": "step_finish", "part": {"type": "step-finish", "tokens": first}})
send({"type": "step_finish", "part": {"type": "step-finish", "tokens": {"input": 5, "output": 3, "reasoning": 0, "cache": {"read": 0, "write": 0}}}})
for index in range(1100):
    send({"type": "text", "part": {"type": "text", "text": "x"}})
