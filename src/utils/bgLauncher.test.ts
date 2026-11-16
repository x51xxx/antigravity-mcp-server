import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bgSpawnTarget } from "./bgTaskManager.js";

const LAUNCHER = fileURLToPath(new URL("./bgLauncher.js", import.meta.url));

function launch(args: string[], input?: string) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    input,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("bgSpawnTarget: Windows goes through the launcher, elsewhere agy directly", () => {
  assert.deepEqual(bgSpawnTarget(["-p", "hi"], "linux"), {
    command: "agy",
    args: ["-p", "hi"],
  });
  const win = bgSpawnTarget(["-p", "hi"], "win32");
  assert.equal(win.command, process.execPath);
  assert.deepEqual(win.args, [LAUNCHER, "agy", "-p", "hi"]);
});

test("launcher passes stdin/stdout/stderr through and keeps the exit code", () => {
  const script =
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{" +
    "process.stdout.write('out:'+s);process.stderr.write('err:'+s);process.exit(7)})";
  const r = launch([process.execPath, "-e", script], "hello");
  assert.equal(r.status, 7);
  assert.equal(r.stdout, "out:hello");
  assert.equal(r.stderr, "err:hello");
});

test("launcher reports a missing command on stderr with exit code 127", () => {
  const r = launch(["agy-mcp-no-such-command-xyz", "-p", "x"]);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /Failed to start agy-mcp-no-such-command-xyz/);
});
