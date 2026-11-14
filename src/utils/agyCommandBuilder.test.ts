import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgyCommandBuilder,
  defaultSkipPermissions,
} from "./agyCommandBuilder.js";
import { describeAgyFailure, parseAgyErrorLine } from "./agyExecutor.js";
import { READ_ONLY_SETTINGS } from "../constants.js";

async function argv(opts: Record<string, unknown>): Promise<string[]> {
  const r = await new AgyCommandBuilder().build("hi", opts);
  for (const f of r.tempFiles) AgyCommandBuilder.cleanupTempFile(f);
  return r.args;
}

test("passes --model and --effort", async () => {
  const a = await argv({ model: "gemini-4-hydrogen", effort: "xhigh" });
  assert.deepEqual(a.slice(0, 4), [
    "--model",
    "gemini-4-hydrogen",
    "--effort",
    "xhigh",
  ]);
  assert.deepEqual(a.slice(-2), ["-p", "hi"]);
});

test("readOnly adds the Default-mode settings overlay", async () => {
  const a = await argv({ readOnly: true });
  const i = a.indexOf("--settings");
  assert.ok(i >= 0);
  assert.equal(a[i + 1], READ_ONLY_SETTINGS);
  assert.deepEqual(JSON.parse(a[i + 1]), {
    agentMode: "",
    permissions: { allow: [] },
  });
});

test("an explicit mode wins over readOnly", async () => {
  const a = await argv({ readOnly: true, mode: "plan" });
  assert.ok(a.includes("--mode"));
  assert.ok(!a.includes("--settings"));
});

test("stream-json output format is forwarded", async () => {
  const a = await argv({ outputFormat: "stream-json" });
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.ok(
    !(await argv({ outputFormat: "text" })).includes("--output-format"),
  );
});

test("rejects effort with an Orchestrator model", async () => {
  await assert.rejects(
    argv({ model: "Orchestrator (Argon)", effort: "high" }),
    /fixed thinking level/,
  );
});

test("rejects effort combined with a display label", async () => {
  await assert.rejects(
    argv({ model: "Gemini 4 Hydrogen (High)", effort: "low" }),
    /base model ID/,
  );
});

test("rejects unknown effort and mode values, and readOnly + skipPermissions", async () => {
  await assert.rejects(argv({ effort: "ultra" }), /Invalid effort/);
  await assert.rejects(argv({ mode: "yolo" }), /Invalid mode/);
  await assert.rejects(
    argv({ readOnly: true, skipPermissions: true }),
    /readOnly/,
  );
});

test("describeAgyFailure keeps the CLI's model-selection error", () => {
  const msg = describeAgyFailure({
    code: 1,
    stdout: "",
    stderr:
      'error: invalid model selection (--model "gemini-3.8-flash" --effort "max"): gemini-3.8-flash has no "max" effort (available: low, medium, high)',
    timedOut: false,
    timeoutMs: 1000,
  });
  assert.match(msg, /^Model error: invalid model selection/);
  assert.match(msg, /available: low, medium, high/);
});

test("describeAgyFailure does not mistake 'not found' text for a missing CLI", () => {
  const msg = describeAgyFailure({
    code: 3,
    stdout: "",
    stderr:
      "The requested model was not found, or your project does not have access to it.",
    timedOut: false,
    timeoutMs: 1000,
  });
  assert.doesNotMatch(msg, /Antigravity CLI not found/);
  assert.match(msg, /exit 3/);
});

test("describeAgyFailure: timeout and ENOENT are decided by process state", () => {
  assert.match(
    describeAgyFailure({
      code: null,
      stdout: "",
      stderr: "permission denied",
      timedOut: true,
      timeoutMs: 5000,
    }),
    /timed out after 5000ms/,
  );
  assert.match(
    describeAgyFailure({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnNotFound: true,
      timeoutMs: 1,
    }),
    /Antigravity CLI not found/,
  );
});

test("parseAgyErrorLine extracts the structured AGY_ERROR payload", () => {
  const stderr =
    'some log\nAGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"message":"model overloaded"}\n';
  assert.deepEqual(parseAgyErrorLine(stderr), {
    status: "UNAVAILABLE",
    code: 503,
    retryable: true,
    message: "model overloaded",
  });
  assert.equal(parseAgyErrorLine("nothing here"), null);
  assert.match(
    describeAgyFailure({
      code: 3,
      stdout: "",
      stderr,
      timedOut: false,
      timeoutMs: 1,
    }),
    /agent error \(exit 3\): model overloaded/,
  );
});

test("long prompts go in as one stream-json user event on stdin, without -p", async () => {
  const long = "x".repeat(150_000) + ' "quoted"\nline2';
  const r = await new AgyCommandBuilder().build(long, { readOnly: true });
  for (const f of r.tempFiles) AgyCommandBuilder.cleanupTempFile(f);
  assert.equal(r.streamJsonOutput, true);
  assert.ok(!r.args.includes("-p"), "agy ≥1.5 rejects a bare -p");
  assert.ok(!r.args.some((a) => a.length > 10_000), "prompt not in argv");
  const i = r.args.indexOf("--input-format");
  assert.equal(r.args[i + 1], "stream-json");
  const o = r.args.indexOf("--output-format");
  assert.equal(r.args[o + 1], "stream-json");
  assert.ok(r.stdin?.endsWith("\n"));
  assert.equal(
    r.stdin!.trim().split("\n").length,
    1,
    "exactly one NDJSON line",
  );
  assert.deepEqual(JSON.parse(r.stdin!), {
    event: "user",
    message: { content: long },
  });
});

test("a long prompt replaces a requested json output with stream-json", async () => {
  const r = await new AgyCommandBuilder().build("y".repeat(150_000), {
    outputFormat: "json",
  });
  for (const f of r.tempFiles) AgyCommandBuilder.cleanupTempFile(f);
  const formats = r.args.filter((_, i) => r.args[i - 1] === "--output-format");
  assert.deepEqual(formats, ["stream-json"]);
});

test("short prompts still use -p <prompt>", async () => {
  const r = await new AgyCommandBuilder().build("short", {});
  for (const f of r.tempFiles) AgyCommandBuilder.cleanupTempFile(f);
  assert.equal(r.streamJsonOutput, undefined);
  assert.deepEqual(r.args.slice(-2), ["-p", "short"]);
  assert.equal(r.stdin, undefined);
});

test("an explicit mode turns the headless skip-permissions default off", () => {
  assert.equal(defaultSkipPermissions(undefined), true);
  assert.equal(defaultSkipPermissions(""), true);
  for (const m of ["plan", "accept-edits", "auto"]) {
    assert.equal(defaultSkipPermissions(m), false, m);
  }
});

test("mode plan cannot be combined with skipPermissions", async () => {
  await assert.rejects(
    argv({ mode: "plan", skipPermissions: true }),
    /mode "plan" cannot be combined with skipPermissions/,
  );
  const a = await argv({ mode: "plan" });
  assert.ok(a.includes("--mode"));
  assert.ok(!a.includes("--dangerously-skip-permissions"));
});

test("parseAgyErrorLine skips mentions of AGY_ERROR that are not JSON", () => {
  const stderr = [
    "I1114 log.go:1] will print AGY_ERROR: on failure",
    'AGY_ERROR: {"message":"quota exhausted"}',
  ].join("\n");
  assert.deepEqual(parseAgyErrorLine(stderr), { message: "quota exhausted" });
});
