import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// bg tasks write under ~/.agy-mcp; keep this test out of the real home.
const home = realpathSync(mkdtempSync(join(tmpdir(), "agy-toolerr-home-")));
process.env.HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { listSessionsTool } = await import("./list-sessions.tool.js");
const { bgAgyTool } = await import("./bg-agy.tool.js");
const { batchAgyTool } = await import("./batch-agy.tool.js");

// mode plan + skipPermissions is rejected by the command builder, so these
// fail before agy would be spawned.
const REJECTED = { mode: "plan", skipPermissions: true };

test("list-sessions: deleting a missing session is an error result", async () => {
  const r = (await listSessionsTool.execute({
    action: "delete",
    sessionId: "nope",
  } as any)) as any;
  assert.equal(r.isError, true);
  assert.match(r.text, /not found/);
});

test("bg-antigravity: a failed start is a categorized error result", async () => {
  const r = (await bgAgyTool.execute({
    action: "start",
    prompt: "x",
    ...REJECTED,
  } as any)) as any;
  assert.equal(r.isError, true);
  assert.match(r.text, /^❌ \*\*/);
  assert.match(r.text, /mode "plan" cannot be combined/);
});

test("batch-antigravity: when every task fails the report is kept", async () => {
  const r = (await batchAgyTool.execute({
    tasks: [{ task: "a" }, { task: "b" }],
    ...REJECTED,
  } as any)) as any;
  assert.equal(r.isError, true);
  assert.match(r.text, /All 2 tasks failed/);
  assert.match(r.text, /Batch Execution Summary/);
  assert.match(r.text, /mode "plan" cannot be combined/);
});
