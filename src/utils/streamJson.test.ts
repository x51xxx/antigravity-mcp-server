import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeStreamJson } from "./streamJson.js";

// Trimmed from a real `agy -p --output-format stream-json` run (CLI v1.5.9).
const CONV = "b1fe277f-fffa-4f02-bbca-de82998719c0";
const RUN = [
  { event: "init", conversation_id: CONV, init: { cwd: "/tmp", tools: [] } },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 0,
      state: "DONE",
      step_type: "user_input",
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" } },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "ls -la" },
        output: "...",
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 3,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "DONE",
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 3,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
    },
  },
  {
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: "DONE\n",
      duration_seconds: 4.2,
      num_turns: 1,
      usage: { input_tokens: 18874, output_tokens: 38 },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

test("summarizes a finished stream-json run", () => {
  const s = summarizeStreamJson(RUN);
  assert.equal(s.conversationId, CONV);
  assert.equal(s.steps, 4);
  assert.deepEqual(s.toolCalls, { run_command: 1 });
  assert.equal(s.lastTool, "run_command: ls -la");
  assert.equal(s.lastText, "DONE\n");
  assert.equal(s.result?.status, "SUCCESS");
  assert.equal(s.result?.response, "DONE\n");
  assert.equal(s.result?.finishedReason, undefined);
  assert.equal(s.result?.usage?.input_tokens, 18874);
});

test("an in-progress run has the conversation id but no result", () => {
  const partial =
    RUN.split("\n").slice(0, 4).join("\n") + '\n{"event":"step_up';
  const s = summarizeStreamJson(partial);
  assert.equal(s.conversationId, CONV);
  assert.equal(s.result, undefined);
  assert.equal(s.unparsedLines, 1);
  assert.equal(s.lastTool, "run_command: ls -la");
});

test("captures error results and denied actions", () => {
  const line = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "",
      status: "ERROR",
      response: "",
      error: 'gemini-3.8-flash has no "max" effort',
      finished_reason: "error",
      denied_actions: [{ action: "read_file", display_name: "ReadFile" }],
    },
  });
  const s = summarizeStreamJson(line);
  assert.equal(s.conversationId, undefined);
  assert.equal(s.result?.status, "ERROR");
  assert.equal(s.result?.finishedReason, "error");
  assert.deepEqual(s.result?.deniedActions, ["read_file"]);
});
