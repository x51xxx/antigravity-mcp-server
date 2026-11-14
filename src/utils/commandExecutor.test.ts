import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeCommandDetailed,
  runWithAbortSignal,
} from "./commandExecutor.js";
import { resolveWorkingDirectory } from "./workingDirResolver.js";

test("aborting the request kills the child process", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const pending = runWithAbortSignal(ac.signal, () =>
    executeCommandDetailed("sleep", ["30"], { timeoutMs: 60_000 }),
  );
  setTimeout(() => ac.abort(), 200);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - started < 10_000, "process should stop promptly");
});

test("an already-aborted request does not spawn anything", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await runWithAbortSignal(ac.signal, () =>
    executeCommandDetailed("sleep", ["30"]),
  );
  assert.equal(r.aborted, true);
  assert.equal(r.code, null);
});

test("without a signal, commands run normally", async () => {
  const r = await runWithAbortSignal(undefined, () =>
    executeCommandDetailed("echo", ["ok"]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "ok");
  assert.equal(r.aborted, undefined);
});

test("an explicit but missing workingDir throws instead of falling back", () => {
  assert.throws(
    () => resolveWorkingDirectory({ workingDir: "/definitely/not/here-xyz" }),
    /Working directory does not exist/,
  );
  assert.equal(
    resolveWorkingDirectory({ workingDir: "/tmp" }) !== undefined,
    true,
  );
});

test("an @path in the prompt wins over the launch dir (PWD)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-cwd-")));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "");
  const saved = process.env.AGY_MCP_CWD;
  delete process.env.AGY_MCP_CWD;
  try {
    assert.equal(
      resolveWorkingDirectory({
        prompt: `explain @${join(root, "src", "a.ts")}`,
      }),
      root,
    );
  } finally {
    if (saved !== undefined) process.env.AGY_MCP_CWD = saved;
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a leftover grandchild holding stdout does not hang the call", async () => {
  const started = Date.now();
  // sh exits right away; the backgrounded sleep inherits stdout and keeps the
  // pipe open for 30 s.
  const r = await executeCommandDetailed(
    "sh",
    ["-c", "sleep 30 & echo $!; echo done"],
    { timeoutMs: 60_000 },
  );
  assert.equal(r.ok, true);
  assert.match(r.stdout, /done$/);
  assert.ok(
    Date.now() - started < 10_000,
    "should not wait for the grandchild",
  );
  const pid = Number(r.stdout.split("\n")[0]);
  if (alive(pid)) process.kill(pid, "SIGKILL");
});

test("a timeout kills the whole process tree, not just the child", async () => {
  const started = Date.now();
  const r = await executeCommandDetailed(
    "sh",
    ["-c", "sleep 30 & echo $!; wait"],
    { timeoutMs: 500 },
  );
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "should stop promptly");
  const pid = Number(r.stdout.split("\n")[0]);
  assert.ok(pid > 0, `grandchild pid in output: ${r.stdout}`);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(alive(pid), false, "grandchild should be killed");
});

test("a missing cwd is reported as such, not as a missing binary", async () => {
  const r = await executeCommandDetailed("git", ["status"], {
    cwd: "/definitely/not/here-xyz",
  });
  assert.equal(r.ok, false);
  assert.equal(r.spawnNotFound, undefined);
  assert.match(r.stderr, /Working directory does not exist/);
});

test("a missing binary is still reported as not found", async () => {
  const r = await executeCommandDetailed("definitely-not-a-binary-xyz", []);
  assert.equal(r.spawnNotFound, true);
});

test("truncateForLog cuts long strings at any depth", async () => {
  const { truncateForLog } = await import("./logger.js");
  const big = "x".repeat(5000);
  const out = truncateForLog({
    prompt: big,
    nested: { list: [big, "ok"] },
    n: 1,
  }) as any;
  assert.ok(out.prompt.length < 300);
  assert.match(out.prompt, /\[5000 chars\]$/);
  assert.ok(out.nested.list[0].length < 300);
  assert.equal(out.nested.list[1], "ok");
  assert.equal(out.n, 1);
});

test("stderr keeps only its tail beyond maxStderrBytes", async () => {
  const r = await executeCommandDetailed(
    "sh",
    ["-c", "head -c 300000 /dev/zero | tr '\\0' x >&2; echo THE-END >&2"],
    { maxStderrBytes: 10_000 },
  );
  assert.equal(r.ok, true);
  assert.ok(r.stderr.length < 10_200, `stderr length ${r.stderr.length}`);
  assert.match(r.stderr, /^\[… \d+ earlier bytes of stderr dropped …\]/);
  assert.match(r.stderr, /THE-END$/);
});

test("@path references ignore e-mail-like text", async () => {
  const { extractPathFromAtSyntax } = await import("./workingDirResolver.js");
  assert.deepEqual(
    extractPathFromAtSyntax("mail me at user@host/inbox", "/b"),
    [],
  );
  assert.deepEqual(extractPathFromAtSyntax("x@/etc/hosts", "/b"), []);
  assert.deepEqual(extractPathFromAtSyntax("explain @src/a.ts", "/b"), [
    "/b/src/a.ts",
  ]);
  assert.deepEqual(extractPathFromAtSyntax("@/abs/f.ts", "/b"), ["/abs/f.ts"]);
});
