import { z } from "zod";
import { defaultSkipPermissions } from "../utils/agyCommandBuilder.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { UnifiedTool, ToolExecuteResult, toolError } from "./registry.js";
import { agyFailureText } from "../utils/errorTypes.js";
import { withSessionLock } from "../utils/sessionStorage.js";
import {
  startBgTask,
  getBgTask,
  stopBgTask,
  removeBgTask,
  readTaskStream,
  isValidTaskId,
  BgTaskMeta,
} from "../utils/bgTaskManager.js";
import { executeCommandDetailed } from "../utils/commandExecutor.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";
import { fetchModels, pickOrchestrator } from "../utils/modelList.js";
import { StreamSummary } from "../utils/streamJson.js";
import { DEFAULT_MODEL } from "../constants.js";
import { effortSchema, modeSchema, stopSignalSchema } from "./sharedSchemas.js";

/**
 * delegate-antigravity — hand a long, multi-step implementation task to
 * Antigravity and come back for the result.
 *
 * - Runs detached (survives the MCP call and server restarts) in its own git
 *   worktree on a fresh branch, so the caller's checkout is untouched.
 * - Defaults to the Orchestrator model when the account has one: a planner
 *   (Argon / Carbon) plans and reviews, Gemini 4 Hydrogen implements, builds,
 *   tests, and hands control back to the planner when verification keeps
 *   failing — built for long tasks. Falls back to DEFAULT_MODEL otherwise.
 * - Captures `--output-format stream-json`, so `status` shows live progress
 *   (steps, tool calls, latest text) and `result` returns the agent's final
 *   answer, outcome, token usage and the diff.
 * - `continue` sends a follow-up turn into the same conversation and worktree
 *   ("tests still fail — fix X"), so one delegation can span many turns.
 */

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours per turn

const delegateArgsSchema = z.object({
  action: z
    .enum(["start", "status", "continue", "result", "collect", "stop", "list"])
    .default("start")
    .describe(
      "start: spawn a delegated task; status: live progress; continue: send a follow-up turn to the same conversation; result (alias collect): final answer + diff; stop: kill the running turn; list: all delegations.",
    ),
  task: z
    .string()
    .optional()
    .describe("What Antigravity should accomplish (required for start)."),
  message: z
    .string()
    .optional()
    .describe("Follow-up instruction for action=continue."),
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
      'Command the agent must run to verify its work (e.g. "npm test"); it is told to loop until it passes.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      `Model ID or label. Omit to use the Orchestrator (Carbon, else Argon) when your plan has one, otherwise ${DEFAULT_MODEL}.`,
    ),
  effort: effortSchema.describe(
    "--effort for non-Orchestrator models (Orchestrator has a fixed thinking level).",
  ),
  mode: modeSchema,
  skipPermissions: z
    .boolean()
    .optional()
    .describe(
      "--dangerously-skip-permissions (default true: a headless run cannot answer permission prompts; false when `mode` is set; not allowed with mode plan). The worktree isolates git state, NOT the filesystem — the agent can still read/write outside it and run any command.",
    ),
  sandbox: z
    .boolean()
    .optional()
    .describe("--sandbox: run terminal commands in the OS sandbox."),
  timeout: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Per-turn --print-timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS} = 2h; 0 = no limit).`,
    ),
  taskId: z
    .string()
    .optional()
    .describe(
      "Delegation ID returned by start (any turn's task ID also works).",
    ),
  cleanup: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "On result/collect: also remove the worktree and delete the branch after grabbing the diff.",
    ),
  signal: stopSignalSchema,
});

interface DelegationTurn {
  taskId: string;
  kind: "start" | "continue";
  startedAt: number;
  message: string;
}

interface DelegationMeta {
  /** ID of the first turn's background task — the delegation's handle. */
  taskId: string;
  worktreePath: string;
  branchName: string;
  /** The ref the caller asked for (display only). */
  baseBranch: string;
  /** Resolved commit the worktree started from — diffs are taken against it. */
  baseSha?: string;
  repoRoot: string;
  model?: string;
  conversationId?: string;
  options?: {
    effort?: string;
    mode?: string;
    skipPermissions?: boolean;
    sandbox?: boolean;
    timeoutMs?: number;
  };
  turns?: DelegationTurn[];
}

const DELEGATIONS_DIR = join(homedir(), ".agy-mcp", "delegations");
const META_FILE = join(DELEGATIONS_DIR, "index.json");

function ensureDir(): void {
  if (!existsSync(DELEGATIONS_DIR))
    mkdirSync(DELEGATIONS_DIR, { recursive: true, mode: 0o700 });
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

/**
 * Read-modify-write the index in one synchronous step. Handlers hold a
 * snapshot across `await`s (git, spawn), so writing that snapshot back would
 * drop entries another call added meanwhile; re-reading right before the
 * write avoids it. The write is atomic (tmp file + rename), so a crash or a
 * concurrent reader never sees a half-written file.
 */
function updateIndex(
  mutate: (idx: Record<string, DelegationMeta>) => void,
): void {
  const idx = loadIndex();
  mutate(idx);
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, META_FILE);
}

/** Turns of a delegation, including entries written before turns existed. */
function turnsOf(d: DelegationMeta): DelegationTurn[] {
  return d.turns?.length
    ? d.turns
    : [{ taskId: d.taskId, kind: "start", startedAt: 0, message: "" }];
}

function findDelegation(
  idx: Record<string, DelegationMeta>,
  id: string,
): DelegationMeta | undefined {
  return (
    idx[id] ??
    Object.values(idx).find((d) => turnsOf(d).some((t) => t.taskId === id))
  );
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

/**
 * Remove a delegation's worktree and branch. Each step counts as done when it
 * succeeds or when there is nothing left to remove, so a retry after a partial
 * failure (or a worktree deleted by hand) can still finish the cleanup.
 */
async function removeWorktreeAndBranch(d: DelegationMeta): Promise<{
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let worktreeRemoved = !existsSync(d.worktreePath);
  if (!worktreeRemoved) {
    const rm = await runGit(d.repoRoot, [
      "worktree",
      "remove",
      "--force",
      d.worktreePath,
    ]);
    worktreeRemoved = rm.ok || !existsSync(d.worktreePath);
    if (!worktreeRemoved)
      errors.push(`git worktree remove: ${rm.stderr.trim() || "failed"}`);
  }
  if (!worktreeRemoved) {
    // The branch is still checked out in the worktree; git would refuse.
    return { worktreeRemoved, branchDeleted: false, errors };
  }
  // Drop git's record of a worktree directory that was deleted by hand.
  await runGit(d.repoRoot, ["worktree", "prune"]);
  const exists = await runGit(d.repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${d.branchName}`,
  ]);
  let branchDeleted = !exists.ok;
  if (!branchDeleted) {
    const del = await runGit(d.repoRoot, ["branch", "-D", d.branchName]);
    branchDeleted = del.ok;
    if (!del.ok) errors.push(`git branch -D: ${del.stderr.trim() || "failed"}`);
  }
  return { worktreeRemoved, branchDeleted, errors };
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
    `You are working in a dedicated git worktree at: ${args.worktreePath}`,
    `Work only inside this directory. The caller will review your diff and apply it selectively.`,
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
    `- Plan first, then implement step by step and verify each step.`,
    `- Keep changes minimal and focused on the task. No drive-by refactors.`,
    `- Do NOT commit — the caller will inspect \`git diff\` and stage selectively.`,
    `- Finish with a short report: what changed and why, how it was verified, and anything left undone.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Resolve the model for a new delegation (Orchestrator when available).
 * An explicit `effort` rules out the Orchestrator (fixed thinking level) and
 * display labels (agy rejects label + --effort), so it maps to the base
 * Hydrogen ID instead.
 */
async function resolveModel(
  requested?: string,
  effort?: string,
): Promise<{
  model?: string;
  note: string;
}> {
  if (requested) return { model: requested, note: "requested" };
  if (effort) {
    return {
      model: "gemini-4-hydrogen",
      note: `auto: Gemini 4 Hydrogen (effort ${effort}; Orchestrator takes no effort)`,
    };
  }
  try {
    const orchestrator = pickOrchestrator(await fetchModels());
    if (orchestrator) {
      return {
        model: orchestrator.id || orchestrator.label,
        note: `auto: ${orchestrator.label}`,
      };
    }
  } catch {
    /* fall through */
  }
  return {
    model: DEFAULT_MODEL,
    note: "auto: no Orchestrator on this account",
  };
}

function formatUsage(u?: Record<string, number>): string {
  if (!u) return "n/a";
  const parts = ["input_tokens", "output_tokens", "thinking_tokens"]
    .filter((k) => typeof u[k] === "number")
    .map((k) => `${k.replace("_tokens", "")} ${u[k]}`);
  return parts.join(", ") || "n/a";
}

function progressLines(stream: StreamSummary | null): string {
  if (!stream) return "progress:   (no structured output)";
  const tools = Object.entries(stream.toolCalls)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(", ");
  const text = stream.lastText.trim();
  return [
    `steps:      ${stream.steps}`,
    `tools:      ${tools || "—"}`,
    `last tool:  ${stream.lastTool ?? "—"}`,
    text
      ? `latest text:\n${text.length > 800 ? "…" + text.slice(-800) : text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function elapsed(bg: BgTaskMeta): string {
  const s = Math.round(((bg.finishedAt ?? Date.now()) - bg.startedAt) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

async function validateRef(
  repo: string,
  ref: string,
): Promise<string | undefined> {
  if (ref.startsWith("-")) return undefined;
  const r = await runGit(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  return r.ok ? r.stdout.trim() : undefined;
}

export const delegateAgyTool: UnifiedTool = {
  name: "delegate-antigravity",
  description:
    "Delegate a long, multi-step implementation task to Antigravity. Runs detached in its own git worktree/branch, by default on the Orchestrator model (planner + Gemini 4 Hydrogen implementer, built for long tasks). Returns a taskId immediately; poll `status` for live progress, `continue` to send follow-up instructions into the same conversation, and `result` for the final answer + diff. The worktree isolates git state only — with skipPermissions (default) the agent can run any command.",
  zodSchema: delegateArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  category: "utility",
  // Calls on the same delegation run one at a time: two concurrent
  // `continue`s would otherwise both see the last turn finished and start two
  // agy runs in the same worktree and conversation.
  execute: (args, onProgress) => {
    const id = args.taskId as string | undefined;
    if (
      !id ||
      !isValidTaskId(id) ||
      (args.action as string) === "start" ||
      (args.action as string) === "list"
    ) {
      return executeUnlocked(args, onProgress);
    }
    const root = findDelegation(loadIndex(), id)?.taskId ?? id;
    return withSessionLock(`delegate:${root}`, () =>
      executeUnlocked(args, onProgress),
    );
  },
};

async function executeUnlocked(
  args: Record<string, unknown>,
  _onProgress?: (newOutput: string) => void,
): Promise<ToolExecuteResult> {
  {
    const action = (args.action as string) || "start";

    if (action === "start") {
      const task = (args.task as string | undefined)?.trim();
      if (!task) throw new Error("task is required for action=start");

      const repoRoot = resolveWorkingDirectory({
        workingDir: args.workingDir as string | undefined,
        prompt: task,
      });

      const isRepo = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
      if (!isRepo.ok) {
        return toolError(
          `❌ ${repoRoot} is not inside a git repository — delegate-antigravity requires git for worktree isolation.`,
        );
      }
      const actualRoot = isRepo.stdout.trim();

      const baseBranch = (args.baseBranch as string | undefined) || "HEAD";
      const baseSha = await validateRef(actualRoot, baseBranch);
      if (!baseSha)
        return toolError(`❌ Unknown base branch/commit: ${baseBranch}`);

      const branchName =
        (args.branchName as string | undefined) ||
        `agy/${randomBytes(4).toString("hex")}`;
      // Reject option-like names before git ever sees them (as validateRef
      // and review-changes do), then let git judge the rest.
      if (branchName.startsWith("-")) {
        return toolError(`❌ Invalid branch name: ${branchName}`);
      }
      const refCheck = await runGit(actualRoot, [
        "check-ref-format",
        "--branch",
        branchName,
      ]);
      if (!refCheck.ok) {
        return toolError(`❌ Invalid branch name: ${branchName}`);
      }

      const { model, note: modelNote } = await resolveModel(
        args.model as string | undefined,
        args.effort as string | undefined,
      );

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
        baseSha,
      ]);
      if (!add.ok) {
        return toolError(`❌ Failed to create worktree:\n${add.stderr}`);
      }

      const options = {
        effort: args.effort as string | undefined,
        mode: args.mode as string | undefined,
        skipPermissions:
          (args.skipPermissions as boolean | undefined) ??
          defaultSkipPermissions(args.mode as string | undefined),
        sandbox: args.sandbox as boolean | undefined,
        timeoutMs: (args.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS,
      };

      const prompt = buildDelegationPrompt({
        task,
        acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
        autoTest: args.autoTest as string | undefined,
        worktreePath,
      });

      let meta: BgTaskMeta;
      try {
        meta = await startBgTask(prompt, {
          model,
          ...options,
          workingDir: worktreePath,
          structuredOutput: true,
          label: `delegate:${branchName}`,
        });
      } catch (err) {
        // Don't leave an orphaned worktree + branch behind.
        await runGit(actualRoot, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]);
        await runGit(actualRoot, ["branch", "-D", branchName]);
        return toolError(agyFailureText(err, { model }));
      }

      updateIndex((index) => {
        index[meta.taskId] = {
          taskId: meta.taskId,
          worktreePath,
          branchName,
          baseBranch,
          baseSha,
          repoRoot: actualRoot,
          model,
          options,
          turns: [
            {
              taskId: meta.taskId,
              kind: "start",
              startedAt: meta.startedAt,
              message: task.slice(0, 300),
            },
          ],
        };
      });

      return {
        text: `🚀 Delegated to Antigravity in an isolated worktree\n\ntaskId:    ${meta.taskId}\nmodel:     ${model ?? "CLI default"} (${modelNote})\nbranch:    ${branchName}\nworktree:  ${worktreePath}\nbase:      ${baseBranch} (${baseSha.slice(0, 12)})\ntimeout:   ${options.timeoutMs ? `${Math.round(options.timeoutMs / 60000)} min per turn` : "none"}\n\nProgress:  delegate-antigravity action=status taskId=${meta.taskId}\nFollow-up: delegate-antigravity action=continue taskId=${meta.taskId} message="…"\nResult:    delegate-antigravity action=result taskId=${meta.taskId}`,
        structuredContent: {
          taskId: meta.taskId,
          model,
          worktreePath,
          branchName,
          baseBranch,
          baseSha,
          pid: meta.pid,
        },
      };
    }

    if (action === "list") {
      const idx = loadIndex();
      const rows = Object.values(idx).map((d) => {
        const turns = turnsOf(d);
        const bg = getBgTask(turns[turns.length - 1].taskId);
        return {
          taskId: d.taskId,
          state: bg?.state ?? "missing",
          turns: turns.length,
          branch: d.branchName,
          model: d.model,
          worktreePath: d.worktreePath,
        };
      });
      if (rows.length === 0) return "No delegations recorded.";
      return {
        text: rows
          .map(
            (r) =>
              `${r.taskId}  ${r.state.padEnd(9)}  turns:${r.turns}  ${r.branch}  ${r.model ?? ""}`,
          )
          .join("\n"),
        structuredContent: { delegations: rows },
      };
    }

    const id = args.taskId as string | undefined;
    if (!id) throw new Error(`taskId is required for action=${action}`);
    if (!isValidTaskId(id)) return toolError(`❌ Invalid taskId: ${id}`);

    const idx = loadIndex();
    const delegation = findDelegation(idx, id);
    if (!delegation) return toolError(`❌ No delegation found for ${id}`);
    const turns = turnsOf(delegation);
    const current = turns[turns.length - 1];
    const bg = getBgTask(current.taskId);
    if (!bg)
      return toolError(`❌ Background task ${current.taskId} state missing.`);
    const stream = readTaskStream(current.taskId);
    const conversationId =
      stream?.conversationId || bg.conversationId || delegation.conversationId;
    if (conversationId && delegation.conversationId !== conversationId) {
      delegation.conversationId = conversationId;
      updateIndex((fresh) => {
        const d = fresh[delegation.taskId];
        if (d) d.conversationId = conversationId;
      });
    }

    const worktreeExists = existsSync(delegation.worktreePath);
    const worktreeGoneNote = `⚠️ Worktree ${delegation.worktreePath} no longer exists (deleted by hand?). Use action=result cleanup=true to drop the branch and this record.`;

    if (action === "status") {
      const gitStatus = worktreeExists
        ? await runGit(delegation.worktreePath, ["status", "--short"])
        : { stdout: "", stderr: "", ok: false };
      return {
        text: `delegation ${delegation.taskId} — turn ${turns.length} (${current.taskId})\nstate:      ${bg.state} (${elapsed(bg)})\nmodel:      ${delegation.model ?? "CLI default"}\nbranch:     ${delegation.branchName}\nworktree:   ${delegation.worktreePath}\nconversation: ${conversationId ?? "(not yet known)"}\n${progressLines(stream)}\n\n${worktreeExists ? `git status:\n${gitStatus.ok ? gitStatus.stdout || "(clean)" : `⚠️ ${gitStatus.stderr.trim() || "git status failed"}`}` : worktreeGoneNote}`,
        structuredContent: {
          state: bg.state,
          exitCode: bg.exitCode,
          turn: turns.length,
          currentTaskId: current.taskId,
          conversationId,
          steps: stream?.steps,
          toolCalls: stream?.toolCalls,
          lastTool: stream?.lastTool,
          gitStatusShort: gitStatus.stdout,
          worktreeExists,
          delegation,
        },
      };
    }

    if (action === "stop") {
      const signal = (args.signal as NodeJS.Signals | undefined) ?? "SIGTERM";
      const ok = stopBgTask(current.taskId, signal);
      return ok
        ? `🛑 Sent ${signal} to turn ${turns.length} (${current.taskId}). The worktree is kept; use action=continue to resume the conversation or action=result to collect the diff.`
        : `Task ${current.taskId} is not running (state: ${bg.state}).`;
    }

    if (bg.state === "running") {
      return `⏳ Turn ${turns.length} (${current.taskId}) is still running (${elapsed(bg)}). Check action=status, wait, or action=stop first.`;
    }

    if (action === "continue") {
      const message = (args.message as string | undefined)?.trim();
      if (!message) throw new Error("message is required for action=continue");
      if (!conversationId) {
        return toolError(
          `❌ The conversation ID of ${current.taskId} is unknown, so it cannot be resumed.`,
        );
      }
      if (!existsSync(delegation.worktreePath)) {
        return toolError(
          `❌ Worktree ${delegation.worktreePath} no longer exists (cleaned up?).`,
        );
      }
      const opts = delegation.options ?? {};
      let meta: BgTaskMeta;
      try {
        meta = await startBgTask(message, {
          model: delegation.model,
          effort: opts.effort,
          mode: opts.mode,
          skipPermissions:
            opts.skipPermissions ?? defaultSkipPermissions(opts.mode),
          sandbox: opts.sandbox,
          timeoutMs:
            (args.timeout as number | undefined) ??
            opts.timeoutMs ??
            DEFAULT_TIMEOUT_MS,
          conversationId,
          workingDir: delegation.worktreePath,
          structuredOutput: true,
          label: `delegate:${delegation.branchName}#${turns.length + 1}`,
        });
      } catch (error) {
        return toolError(agyFailureText(error, { model: delegation.model }));
      }
      delegation.turns = [
        ...turns,
        {
          taskId: meta.taskId,
          kind: "continue",
          startedAt: meta.startedAt,
          message: message.slice(0, 300),
        },
      ];
      const newTurns = delegation.turns;
      updateIndex((fresh) => {
        const d = fresh[delegation.taskId];
        if (d) d.turns = newTurns;
      });
      return {
        text: `▶️ Turn ${delegation.turns.length} started in conversation ${conversationId}\n\ntaskId: ${delegation.taskId} (turn task ${meta.taskId})\nProgress: delegate-antigravity action=status taskId=${delegation.taskId}`,
        structuredContent: {
          taskId: delegation.taskId,
          turnTaskId: meta.taskId,
          turn: delegation.turns.length,
          conversationId,
        },
      };
    }

    if (action === "result" || action === "collect") {
      const base = delegation.baseSha || delegation.baseBranch;
      const noGit = { stdout: "", stderr: "", ok: true };
      let diff = noGit;
      let stat = noGit;
      let untracked = noGit;
      if (worktreeExists) {
        // Mark new files intent-to-add so they show up in the diff (the
        // worktree's index belongs to the delegation branch, not the caller).
        await runGit(delegation.worktreePath, [
          "add",
          "--intent-to-add",
          "--all",
        ]);
        diff = await runGit(delegation.worktreePath, [
          "diff",
          "--end-of-options",
          base,
        ]);
        stat = await runGit(delegation.worktreePath, [
          "diff",
          "--stat",
          "--end-of-options",
          base,
        ]);
        untracked = await runGit(delegation.worktreePath, [
          "ls-files",
          "--others",
          "--exclude-standard",
        ]);
      }

      let cleanupNote = worktreeExists ? "" : `\n\n${worktreeGoneNote}`;
      let cleaned = false;
      if (args.cleanup) {
        const rm = await removeWorktreeAndBranch(delegation);
        cleaned = rm.worktreeRemoved && rm.branchDeleted;
        if (cleaned) {
          // Forget the delegation only once nothing is left behind —
          // otherwise its record is the only handle to the leftovers.
          for (const t of turns) removeBgTask(t.taskId);
          updateIndex((fresh) => {
            delete fresh[delegation.taskId];
          });
          cleanupNote = `\n\n🧹 Cleanup: worktree and branch ${delegation.branchName} removed, task records deleted.`;
        } else {
          cleanupNote = `\n\n⚠️ Cleanup incomplete — worktree removed: ${rm.worktreeRemoved ? "yes" : "no"}, branch deleted: ${rm.branchDeleted ? "yes" : "no"}.\n${rm.errors.join("\n")}\nThe delegation record is kept; fix the cause and run action=result cleanup=true again.`;
        }
      }

      const result = stream?.result;
      const answer =
        result?.response?.trim() || stream?.lastText.trim() || "(no response)";
      const outcome = result
        ? `${result.status}${result.finishedReason ? ` (${result.finishedReason})` : ""}${result.error ? ` — ${result.error}` : ""}`
        : `${bg.state} (exit ${bg.exitCode ?? "n/a"}, no result event)`;
      const gitErrors = [diff, stat]
        .filter((r) => !r.ok)
        .map((r) => r.stderr.trim())
        .filter(Boolean);
      const truncatedDiff =
        diff.stdout.length > 200_000
          ? diff.stdout.slice(0, 200_000) +
            `\n\n… [diff truncated at 200KB; full diff at ${delegation.worktreePath}]`
          : diff.stdout;

      return {
        text: `📦 Delegation ${delegation.taskId} — turn ${turns.length}\n\noutcome:   ${outcome}\nbranch:    ${delegation.branchName}\nworktree:  ${delegation.worktreePath}\nusage:     ${formatUsage(result?.usage)}${result?.deniedActions?.length ? `\ndenied:    ${result.deniedActions.join(", ")}` : ""}\n\n--- agent report ---\n${answer}\n\n--- diffstat ---\n${stat.stdout || "(no changes)"}\n${untracked.stdout ? `\n--- untracked ---\n${untracked.stdout}` : ""}\n\n--- diff ---\n${gitErrors.length ? `⚠️ git diff failed: ${gitErrors.join("; ")}\n` : ""}${truncatedDiff || "(no changes)"}${cleanupNote}`,
        structuredContent: {
          taskId: delegation.taskId,
          turn: turns.length,
          branch: delegation.branchName,
          worktreePath: delegation.worktreePath,
          state: bg.state,
          exitCode: bg.exitCode,
          conversationId,
          status: result?.status,
          finishedReason: result?.finishedReason,
          error: result?.error,
          usage: result?.usage,
          deniedActions: result?.deniedActions,
          response: answer,
          diffstat: stat.stdout,
          diff: diff.stdout,
          untracked: untracked.stdout.split("\n").filter(Boolean),
          cleaned,
          worktreeExists,
        },
      };
    }

    throw new Error(`Unknown action: ${action}`);
  }
}
