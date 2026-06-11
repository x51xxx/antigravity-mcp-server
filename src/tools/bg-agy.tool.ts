import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import {
  startBgTask,
  getBgTask,
  listBgTasks,
  tailLog,
  stopBgTask,
  removeBgTask,
  BgTaskMeta,
} from "../utils/bgTaskManager.js";
import { MODELS } from "../constants.js";

const bgAgyArgsSchema = z.object({
  action: z
    .enum(["start", "status", "tail", "stop", "remove", "list"])
    .describe("Background task action."),

  // start
  prompt: z.string().optional().describe("Prompt (required for action=start)."),
  label: z
    .string()
    .optional()
    .describe("Human-readable label to identify this task later."),
  model: z
    .string()
    .optional()
    .describe(
      `Optional model override. Known: ${Object.values(MODELS).join(", ")}.`,
    ),
  skipPermissions: z
    .boolean()
    .optional()
    .describe(
      "--dangerously-skip-permissions (default for bg tasks: true — print mode can't answer permission prompts).",
    ),
  sandbox: z
    .boolean()
    .optional()
    .describe("--sandbox: run with terminal restrictions enabled."),
  workingDir: z.string().optional(),
  cd: z.string().optional(),
  addDirs: z.array(z.string()).optional(),
  timeout: z
    .number()
    .optional()
    .describe("agy --print-timeout in milliseconds (default 600000)."),

  // status/tail/stop/remove
  taskId: z.string().optional().describe("Task ID returned by action=start."),
  lines: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .default(80)
    .describe("Lines to return from log tail."),
  signal: z
    .enum(["SIGTERM", "SIGKILL", "SIGINT"])
    .optional()
    .default("SIGTERM")
    .describe("Signal for stop action."),
});

function formatMeta(m: BgTaskMeta): Record<string, unknown> {
  return {
    taskId: m.taskId,
    state: m.state,
    pid: m.pid,
    label: m.label,
    model: m.model,
    workingDir: m.workingDir,
    conversationId: m.conversationId,
    startedAt: new Date(m.startedAt).toISOString(),
    finishedAt: m.finishedAt ? new Date(m.finishedAt).toISOString() : undefined,
    exitCode: m.exitCode,
    durationMs: (m.finishedAt ?? Date.now()) - m.startedAt,
    promptPreview: m.prompt,
  };
}

function renderTask(m: BgTaskMeta): string {
  const dur = ((m.finishedAt ?? Date.now()) - m.startedAt) / 1000;
  return `${m.taskId}  ${m.state.padEnd(9)}  ${dur.toFixed(0).padStart(5)}s  ${m.label || m.prompt.slice(0, 60)}`;
}

export const bgAgyTool: UnifiedTool = {
  name: "bg-antigravity",
  description:
    "Run Antigravity CLI as a detached background task. Subactions: start (returns taskId), status, tail (log output), stop, remove, list. Use for long-running autonomous work — the MCP call returns immediately and you poll status later.",
  zodSchema: bgAgyArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  category: "utility",
  execute: async (args) => {
    const action = args.action as string;

    if (action === "start") {
      const prompt = (args.prompt as string | undefined)?.trim();
      if (!prompt) throw new Error("prompt is required for action=start");

      const meta = await startBgTask(prompt, {
        model: args.model as string | undefined,
        skipPermissions: args.skipPermissions as boolean | undefined,
        sandbox: args.sandbox as boolean | undefined,
        workingDir: (args.workingDir || args.cd) as string | undefined,
        cd: args.cd as string | undefined,
        addDirs: args.addDirs as string[] | undefined,
        timeoutMs: args.timeout as number | undefined,
        label: args.label as string | undefined,
      });

      const m = formatMeta(meta);
      return {
        text: `✅ Background task started\n\ntaskId: ${meta.taskId}\npid: ${meta.pid}\nworkingDir: ${meta.workingDir ?? "(default)"}\n\nPoll with:  bg-antigravity action=status taskId=${meta.taskId}\nTail logs:  bg-antigravity action=tail taskId=${meta.taskId}\nStop:       bg-antigravity action=stop taskId=${meta.taskId}`,
        structuredContent: { task: m },
      };
    }

    if (action === "list") {
      const tasks = listBgTasks();
      if (tasks.length === 0) {
        return {
          text: "No background tasks recorded.",
          structuredContent: { tasks: [] },
        };
      }
      const header = "taskId        state      dur    label/prompt";
      const lines = tasks.map(renderTask);
      return {
        text: [header, ...lines].join("\n"),
        structuredContent: { tasks: tasks.map(formatMeta) },
      };
    }

    const taskId = args.taskId as string | undefined;
    if (!taskId) throw new Error(`taskId is required for action=${action}`);

    if (action === "status") {
      const meta = getBgTask(taskId);
      if (!meta) return `❌ No task ${taskId}`;
      return {
        text: `${meta.taskId}\nstate:         ${meta.state}\nexitCode:      ${meta.exitCode ?? "n/a"}\nworkingDir:    ${meta.workingDir ?? "(default)"}\nstartedAt:     ${new Date(meta.startedAt).toISOString()}\nfinishedAt:    ${meta.finishedAt ? new Date(meta.finishedAt).toISOString() : "still running"}\nconversation:  ${meta.conversationId ?? "(not yet parsed)"}\nlabel:         ${meta.label ?? "—"}\nprompt:        ${meta.prompt}`,
        structuredContent: { task: formatMeta(meta) },
      };
    }

    if (action === "tail") {
      const meta = getBgTask(taskId);
      if (!meta) return `❌ No task ${taskId}`;
      const log = tailLog(taskId, (args.lines as number) || 80);
      return {
        text: `=== ${meta.taskId} [${meta.state}] tail ${args.lines || 80} lines ===\n${log || "(log empty)"}`,
        structuredContent: { task: formatMeta(meta), log },
      };
    }

    if (action === "stop") {
      const ok = stopBgTask(taskId, args.signal as NodeJS.Signals);
      const meta = getBgTask(taskId);
      return {
        text: ok
          ? `🛑 Sent ${args.signal} to task ${taskId}`
          : `Task ${taskId} not running.`,
        structuredContent: {
          stopped: ok,
          task: meta ? formatMeta(meta) : null,
        },
      };
    }

    if (action === "remove") {
      const ok = removeBgTask(taskId);
      return ok
        ? `🗑️  Removed task ${taskId}`
        : `❌ Cannot remove ${taskId} (still running or not found).`;
    }

    throw new Error(`Unknown action: ${action}`);
  },
};
