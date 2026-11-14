import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOrCreateSession,
  setConversationId,
  clearAllSessions,
} from "./sessionStorage.js";

test("a sessionId reused in another workspace does not resume its conversation", () => {
  clearAllSessions();
  const a = getOrCreateSession("/tmp", "shared");
  setConversationId(a.sessionId, "11111111-1111-1111-1111-111111111111");
  assert.equal(
    getOrCreateSession("/tmp", "shared").conversationId,
    "11111111-1111-1111-1111-111111111111",
  );
  const b = getOrCreateSession(process.cwd(), "shared");
  assert.equal(b.conversationId, undefined);
  assert.notEqual(b.workspaceId, a.workspaceId);
  clearAllSessions();
});

test("a branch switch in the same repo keeps the conversation", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  clearAllSessions();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "agy-sess-")));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const a = getOrCreateSession(repo, "s");
  setConversationId(a.sessionId, "22222222-2222-2222-2222-222222222222");
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature\n");
  assert.equal(
    getOrCreateSession(repo, "s").conversationId,
    "22222222-2222-2222-2222-222222222222",
  );
  clearAllSessions();
});

test("an empty answer replaces the previous turn's lastResponse", async () => {
  const { saveSession, getSession } = await import("./sessionStorage.js");
  clearAllSessions();
  saveSession({ sessionId: "e", lastPrompt: "p1", lastResponse: "first" });
  saveSession({ sessionId: "e", lastPrompt: "p2", lastResponse: "" });
  assert.equal(getSession("e")?.lastResponse, "");
  assert.equal(getSession("e")?.lastPrompt, "p2");
  clearAllSessions();
});
