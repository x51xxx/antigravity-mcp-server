import { test } from "node:test";
import assert from "node:assert/strict";
import { askAgyTool } from "./ask-agy.tool.js";
import {
  getOrCreateSession,
  setConversationId,
  clearAllSessions,
} from "../utils/sessionStorage.js";

const UUID = "33333333-3333-3333-3333-333333333333";

async function dryRunArgv(workingDir: string): Promise<string> {
  const out = await askAgyTool.execute({
    prompt: "hi",
    sessionId: "work",
    workingDir,
    dryRun: true,
  });
  return typeof out === "string" ? out : JSON.stringify(out);
}

test("a sessionId reused in another repo does not pass --conversation", async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const other = realpathSync(mkdtempSync(join(tmpdir(), "agy-ask-")));
  clearAllSessions();
  try {
    setConversationId(getOrCreateSession(other, "work").sessionId, UUID);

    // Same workspace: the conversation is resumed (control).
    assert.match(await dryRunArgv(other), new RegExp(UUID));

    // Another repo with the same sessionId: a fresh conversation.
    setConversationId(getOrCreateSession(other, "work").sessionId, UUID);
    const argv = await dryRunArgv(process.cwd());
    assert.doesNotMatch(argv, new RegExp(UUID));
    assert.doesNotMatch(argv, /--conversation/);
  } finally {
    clearAllSessions();
  }
});
