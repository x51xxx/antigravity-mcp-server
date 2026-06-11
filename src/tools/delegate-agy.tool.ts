import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { UnifiedTool } from "./registry.js";
import { startBgTask, getBgTask } from "../utils/bgTaskManager.js";
import { executeCommandDetailed } from "../utils/commandExecutor.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";

const delegateArgsSchema = z.object({
  action: z
    .enum(["start", "status", "collect"])
    .default("start")
    .describe(
      "start: spawn delegated task; status: check progress; collect: stop + return diff + cleanup option.",
    ),
  task: z
    .string()
    .optional()
    .describe(
      "What Antigravity should accomplish (required for action=start).",
    ),
  acceptanceCriteria: z
    .array(z.string())
    .optional()
    .describe("Bullet list of criteria the implementation must satisfy."),
  baseBranch: z
    .string()
    .optional()
    .describe(
      "Branch/commit to base the worktree on (default: current HEAD of repo).",
    ),
  branchName: z
    .string()
    .optional()
    .describe(
      "Name for the new branch in the worktree. Default: agy/<random>.",
    ),
  workingDir: z
    .string()
    .optional()
    .describe("Repo root (default: resolved automatically)."),
  autoTest: z
    .string()
    .optional()
    .describe(
      'Shell command Antigravity should run after editing to validate (e.g., "npm test"). If passed, the agent is told to loop until it passes.',
    ),
  model: z.string().optional(),
  timeout: z
    .number()
    .optional()
    .describe("agy --print-timeout in milliseconds (default 600000)."),
  // For status/collect
  taskId: z.string().optional(),
  cleanup: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "On collect: also run `git worktree remove` after grabbing the diff.",
    ),
});

interface DelegationMeta {
  taskId: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  repoRoot: string;
}

const DELEGATIONS_DIR = join(homedir(), ".agy-mcp", "delegations");
const META_FILE = join(DELEGATIONS_DIR, "index.json");

function ensureDir(): void {
  if (!existsSync(DELEGATIONS_DIR))
    mkdirSync(DELEGATIONS_DIR, { recursive: true });
}

function loadIndex(): Record<string, DelegationMeta> {
  ensureDir();
  try {
    if (!existsSync(META_FILE)) return {};
    return JSON.parse(readFileSync(META_FILE, "utf8")) as Record<
      string,
      DelegationMeta
    >;
  } catch {
    return {};
  }
}

function saveIndex(idx: Record<string, DelegationMeta>): void {
  ensureDir();
  writeFileSync(META_FILE, JSON.stringify(idx, null, 2), "utf8");
}

async function runGit(
  cwd: string | undefined,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const r = await executeCommandDetailed("git", args, {
    cwd,
    timeoutMs: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, ok: r.ok };
}

function buildDelegationPrompt(args: {
  task: string;
  acceptanceCriteria?: string[];
  autoTest?: string;
  worktreePath: string;
}): string {
  return [
    `# DELEGATED IMPLEMENTATION TASK`,
    ``,
    `You are operating in an isolated git worktree at: ${args.worktreePath}`,
    `Your work is sandboxed — break things freely. The caller will diff your changes and apply selectively.`,
    ``,
    `## Task`,
    args.task,
    args.acceptanceCriteria?.length
      ? `\n## Acceptance Criteria\n${args.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "",
    args.autoTest
      ? `\n## Validation\nAfter every meaningful change, run: \`${args.autoTest}\`\nLoop edit→test until it passes. If it cannot pass after reasonable attempts, summarise what blocks it.`
      : "",
    ``,
    `## Output expectations`,
    `- Make your changes directly in the worktree files.`,
    `- Keep changes minimal and focused on the task. No drive-by refactors.`,
    `- When done, print a short summary of what changed and why.`,
    `- Do NOT commit — the caller will inspect \`git diff\` and stage selectively.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const delegateAgyTool: UnifiedTool = {
  name: "delegate-antigravity",
  description:
    "Delegate an implementation task to Antigravity in an isolated git worktree. The agent runs autonomously (--dangerously-skip-permissions) on a fresh branch, optionally looping against a test command. Returns a taskId; later 'collect' to grab the diff. Safe: changes are sandboxed, caller reviews & applies.",
  zodSchema: delegateArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  category: "utility",
  execute: async (args) => {
    const action = (args.action as string) || "start";

    if (action === "start") {
      const task = (args.task as string | undefined)?.trim();
      if (!task) throw new Error("task is required for action=start");

      const repoRoot = resolveWorkingDirectory({
        workingDir: args.workingDir as string | undefined,
        prompt: task,
      });

      // Confirm it's a git repo
      const isRepo = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
      if (!isRepo.ok) {
        return `❌ ${repoRoot} is not inside a git repository — delegate-antigravity requires git for worktree isolation.`;
      }
      const actualRoot = isRepo.stdout.trim();

      const baseBranch =
        (args.baseBranch as string | undefined) ||
        (await runGit(actualRoot, ["rev-parse", "HEAD"])).stdout.trim();

      const branchName =
        (args.branchName as string | undefined) ||
        `agy/${randomBytes(4).toString("hex")}`;

      ensureDir();
      const worktreePath = join(
        DELEGATIONS_DIR,
        `wt-${randomBytes(4).toString("hex")}`,
      );

      const add = await runGit(actualRoot, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        baseBranch,
      ]);
      if (!add.ok) {
        return `❌ Failed to create worktree:\n${add.stderr}`;
      }

      const prompt = buildDelegationPrompt({
        task,
        acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
        autoTest: args.autoTest as string | undefined,
        worktreePath,
      });

      const meta = await startBgTask(prompt, {
        model: args.model as string | undefined,
        skipPermissions: true,
        workingDir: worktreePath,
        timeoutMs: args.timeout as number | undefined,
        label: `delegate:${branchName}`,
      });

      const index = loadIndex();
      index[meta.taskId] = {
        taskId: meta.taskId,
        worktreePath,
        branchName,
        baseBranch,
        repoRoot: actualRoot,
      };
      saveIndex(index);

      return {
        text: `🚀 Delegated to Antigravity in isolated worktree\n\ntaskId:    ${meta.taskId}\nbranch:    ${branchName}\nworktree:  ${worktreePath}\nbase:      ${baseBranch.slice(0, 12)}\n\nPoll:    delegate-antigravity action=status taskId=${meta.taskId}\nCollect: delegate-antigravity action=collect taskId=${meta.taskId}`,
        structuredContent: {
          taskId: meta.taskId,
          worktreePath,
          branchName,
          baseBranch,
          pid: meta.pid,
        },
      };
    }

    const taskId = args.taskId as string | undefined;
    if (!taskId) throw new Error(`taskId is required for action=${action}`);

    const idx = loadIndex();
    const delegation = idx[taskId];
    if (!delegation) return `❌ No delegation found for ${taskId}`;
    const bg = getBgTask(taskId);
    if (!bg) return `❌ Background task ${taskId} state missing.`;

    if (action === "status") {
      // Lightweight: just bg state + a peek at git status in the worktree
      const gitStatus = await runGit(delegation.worktreePath, [
        "status",
        "--short",
      ]);
      return {
        text: `task ${taskId}\nstate:      ${bg.state}\nbranch:     ${delegation.branchName}\nworktree:   ${delegation.worktreePath}\n\ngit status:\n${gitStatus.stdout || "(clean)"}`,
        structuredContent: {
          state: bg.state,
          exitCode: bg.exitCode,
          gitStatusShort: gitStatus.stdout,
          delegation,
        },
      };
    }

    if (action === "collect") {
      // Stop if still running, then produce diff
      if (bg.state === "running") {
        // Don't auto-kill — instruct caller. Killing mid-edit might leave a torn change.
        return `⏳ Task ${taskId} still running. Run \`bg-antigravity action=stop taskId=${taskId}\` first, or wait for completion.`;
      }

      const diff = await runGit(delegation.worktreePath, [
        "diff",
        delegation.baseBranch,
      ]);
      const stat = await runGit(delegation.worktreePath, [
        "diff",
        "--stat",
        delegation.baseBranch,
      ]);
      const untracked = await runGit(delegation.worktreePath, [
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);

      let cleanupNote = "";
      if (args.cleanup) {
        const rm = await runGit(delegation.repoRoot, [
          "worktree",
          "remove",
          "--force",
          delegation.worktreePath,
        ]);
        const del = await runGit(delegation.repoRoot, [
          "branch",
          "-D",
          delegation.branchName,
        ]);
        cleanupNote = `\n\n🧹 Cleanup: worktree removed (${rm.ok ? "ok" : "failed"}), branch deleted (${del.ok ? "ok" : "failed"}).`;
        delete idx[taskId];
        saveIndex(idx);
      }

      const truncatedDiff =
        diff.stdout.length > 200_000
          ? diff.stdout.slice(0, 200_000) +
            `\n\n… [diff truncated at 200KB; full diff at ${delegation.worktreePath}]`
          : diff.stdout;

      return {
        text: `📦 Delegation ${taskId} collected\n\nbranch:    ${delegation.branchName}\nstate:     ${bg.state} (exit ${bg.exitCode ?? "n/a"})\nworktree:  ${delegation.worktreePath}\n\n--- diffstat ---\n${stat.stdout || "(no changes)"}\n${untracked.stdout ? `\n--- untracked ---\n${untracked.stdout}` : ""}\n\n--- diff ---\n${truncatedDiff || "(no committed changes — check untracked above)"}${cleanupNote}`,
        structuredContent: {
          taskId,
          branch: delegation.branchName,
          worktreePath: delegation.worktreePath,
          state: bg.state,
          exitCode: bg.exitCode,
          diffstat: stat.stdout,
          diff: diff.stdout,
          untracked: untracked.stdout.split("\n").filter(Boolean),
          cleaned: Boolean(args.cleanup),
        },
      };
    }

    throw new Error(`Unknown action: ${action}`);
  },
};
