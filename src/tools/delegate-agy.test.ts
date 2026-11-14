import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// State lives under ~/.agy-mcp; point HOME at a scratch dir before the tool
// modules compute their paths (each test file runs in its own process).
const home = realpathSync(mkdtempSync(join(tmpdir(), "agy-deleg-home-")));
process.env.HOME = home;
const { delegateAgyTool } = await import("./delegate-agy.tool.js");
after(() => rmSync(home, { recursive: true, force: true }));

const TASK = "abcdef012345";
const BRANCH = "agy/test";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agy-deleg-")));
  const repo = join(base, "repo");
  const wt = join(base, "wt");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", BRANCH, wt);

  const bgDir = join(home, ".agy-mcp", "bg");
  const delDir = join(home, ".agy-mcp", "delegations");
  mkdirSync(bgDir, { recursive: true });
  mkdirSync(delDir, { recursive: true });
  writeFileSync(
    join(bgDir, `${TASK}.json`),
    JSON.stringify({
      taskId: TASK,
      pid: 0,
      state: "completed",
      prompt: "x",
      args: [],
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      exitCode: 0,
      outputFormat: "stream-json",
    }),
  );
  writeFileSync(
    join(delDir, "index.json"),
    JSON.stringify({
      [TASK]: {
        taskId: TASK,
        worktreePath: wt,
        branchName: BRANCH,
        baseBranch: "HEAD",
        baseSha: sha,
        repoRoot: repo,
        turns: [{ taskId: TASK, kind: "start", startedAt: 0, message: "" }],
      },
    }),
  );
  const index = () =>
    JSON.parse(readFileSync(join(delDir, "index.json"), "utf8"));
  const branchExists = () => {
    try {
      git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`);
      return true;
    } catch {
      return false;
    }
  };
  return {
    base,
    repo,
    wt,
    index,
    branchExists,
    bgMeta: join(bgDir, `${TASK}.json`),
  };
}

const run = (args: Record<string, unknown>) =>
  delegateAgyTool.execute({ taskId: TASK, ...args }) as Promise<any>;

test("a failed worktree removal keeps the delegation record", async () => {
  const t = setup();
  try {
    // A locked worktree is not removed by a single --force.
    git(t.repo, "worktree", "lock", t.wt);
    const r = await run({ action: "result", cleanup: true });
    assert.equal(r.structuredContent.cleaned, false);
    assert.match(r.text, /Cleanup incomplete/);
    assert.ok(t.index()[TASK], "record must be kept");
    assert.ok(existsSync(t.bgMeta), "task record must be kept");
    assert.ok(t.branchExists());

    // After fixing the cause, a retry finishes the cleanup.
    git(t.repo, "worktree", "unlock", t.wt);
    const again = await run({ action: "result", cleanup: true });
    assert.equal(again.structuredContent.cleaned, true);
    assert.equal(t.index()[TASK], undefined);
    assert.equal(existsSync(t.bgMeta), false);
    assert.equal(existsSync(t.wt), false);
    assert.equal(t.branchExists(), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("a worktree deleted by hand is reported, and cleanup still drops the branch", async () => {
  const t = setup();
  try {
    rmSync(t.wt, { recursive: true, force: true });

    const status = await run({ action: "status" });
    assert.equal(status.structuredContent.worktreeExists, false);
    assert.match(status.text, /no longer exists/);
    assert.doesNotMatch(status.text, /not found/);

    const r = await run({ action: "result", cleanup: true });
    assert.equal(r.structuredContent.worktreeExists, false);
    assert.equal(r.structuredContent.cleaned, true);
    assert.equal(t.branchExists(), false);
    assert.equal(t.index()[TASK], undefined);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("stop accepts a signal (SIGKILL for a run that ignores SIGTERM)", async () => {
  const t = setup();
  // A process that ignores SIGTERM, in its own process group like a bg task.
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise((res) => child.once("exit", res));
  try {
    const meta = JSON.parse(readFileSync(t.bgMeta, "utf8"));
    writeFileSync(
      t.bgMeta,
      JSON.stringify({
        ...meta,
        state: "running",
        pid: child.pid,
        finishedAt: undefined,
      }),
    );
    const r = await run({ action: "stop", signal: "SIGKILL" });
    assert.match(String(r), /Sent SIGKILL/);
    await exited;
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
    rmSync(t.base, { recursive: true, force: true });
  }
});

test("start rejects an option-like branchName before running git", async () => {
  const t = setup();
  try {
    for (const branchName of ["-x", "--help"]) {
      const r = await delegateAgyTool.execute({
        action: "start",
        task: "noop",
        workingDir: t.repo,
        branchName,
      } as any);
      assert.equal((r as any).isError, true);
      assert.match((r as any).text, /Invalid branch name/);
    }
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});
