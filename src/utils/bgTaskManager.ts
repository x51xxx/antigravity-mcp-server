// cross-spawn resolves agy.cmd / PATHEXT shims on Windows, like the
// foreground executor does; plain child_process.spawn would hit ENOENT there.
import spawn from "cross-spawn";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  readSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import {
  AgyCommandBuilder,
  AgyCommandBuilderOptions,
  defaultSkipPermissions,
} from "./agyCommandBuilder.js";
import { Logger, truncateForLog } from "./logger.js";
import { parseConversationIdFromLog } from "./agyExecutor.js";
import { metrics } from "./metrics.js";
import { CLI, ERROR_MESSAGES } from "../constants.js";
import { summarizeStreamJson, StreamSummary } from "./streamJson.js";

/**
 * Background task manager for Antigravity CLI.
 *
 * Runs agy processes detached from the MCP server so callers can fire-and-forget
 * long-running agent work and poll for status. State is persisted to disk so
 * tasks survive MCP server restarts.
 *
 * Layout:
 *   ~/.agy-mcp/bg/
 *     <taskId>.json    — metadata (pid, exit code, timestamps, conversation id)
 *     <taskId>.log     — stderr (text-output tasks: merged stdout + stderr)
 *     <taskId>.out     — stdout of structured tasks (stream-json events)
 *     <taskId>.agylog  — agy's own CLI log (--log-file) — conversation ID source
 */

const STATE_DIR = join(homedir(), ".agy-mcp", "bg");

/** Task IDs are 12 lowercase hex chars; anything else never touches the fs. */
const TASK_ID_RE = /^[a-f0-9]{12}$/;

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

function assertTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid taskId "${taskId}" (expected 12 hex characters).`);
  }
}

export type BgTaskState =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "unknown";

export interface BgTaskMeta {
  taskId: string;
  pid: number;
  state: BgTaskState;
  prompt: string;
  workingDir?: string;
  model?: string;
  args: string[];
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  conversationId?: string;
  label?: string;
  /** "stream-json" when stdout is captured as structured events in <id>.out. */
  outputFormat?: "text" | "stream-json";
}

/**
 * Task files hold prompts, agent output and logs — owner-only access. The mode
 * only applies when a file is created; older files keep theirs.
 */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ensureDir(): void {
  if (!existsSync(STATE_DIR))
    mkdirSync(STATE_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
}

function metaPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.json`);
}

function logPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.log`);
}

function outPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.out`);
}

function agyLogPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.agylog`);
}

function readMeta(taskId: string): BgTaskMeta | null {
  if (!isValidTaskId(taskId)) return null;
  const p = metaPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BgTaskMeta;
  } catch (err) {
    Logger.warn(`Corrupted bg task meta ${taskId}: ${err}`);
    return null;
  }
}

function writeMeta(meta: BgTaskMeta): void {
  writeFileSync(metaPath(meta.taskId), JSON.stringify(meta, null, 2), {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

/** Parse the structured stdout of a stream-json task (empty summary otherwise). */
export function readTaskStream(taskId: string): StreamSummary | null {
  if (!isValidTaskId(taskId)) return null;
  const p = outPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return summarizeStreamJson(readFileSync(p, "utf8"));
  } catch (err) {
    Logger.warn(`Failed to read stream output for ${taskId}: ${err}`);
    return null;
  }
}

function liftConversationId(meta: BgTaskMeta): void {
  if (meta.conversationId) return;
  const fromStream = readTaskStream(meta.taskId)?.conversationId;
  const id = fromStream || parseConversationIdFromLog(agyLogPath(meta.taskId));
  if (id) meta.conversationId = id;
}

/**
 * Final state of a finished task. A stream-json task reports its own outcome
 * in the `result` event; without one (text output, or the process died before
 * finishing) we only know the exit code — and after an MCP server restart not
 * even that, so the state is "unknown" rather than a guessed "completed".
 */
function settledState(
  meta: BgTaskMeta,
  exitCode: number | null | undefined,
  signal?: NodeJS.Signals | null,
): BgTaskState {
  if (meta.state === "killed") return "killed";
  const result = readTaskStream(meta.taskId)?.result;
  if (result) {
    return result.status === "SUCCESS" && !result.finishedReason
      ? "completed"
      : "failed";
  }
  if (signal) return "killed";
  if (exitCode === 0) return "completed";
  if (typeof exitCode === "number") return "failed";
  return "unknown";
}

/**
 * Reconcile on-disk state with reality: if the meta says "running" but the PID
 * is gone, settle the state from the structured result when there is one.
 */
function reconcile(meta: BgTaskMeta): BgTaskMeta {
  if (meta.state !== "running") return meta;
  if (isAlive(meta.pid)) return meta;

  meta.state = settledState(meta, meta.exitCode);
  meta.finishedAt = meta.finishedAt ?? Date.now();
  meta.exitCode = meta.exitCode ?? null;
  liftConversationId(meta);
  writeMeta(meta);
  return meta;
}

export interface StartOptions extends AgyCommandBuilderOptions {
  label?: string;
  /**
   * Capture stdout as `--output-format stream-json` events in <id>.out so
   * progress, the conversation ID and the final result can be read while the
   * task runs and after it ends.
   */
  structuredOutput?: boolean;
}

export async function startBgTask(
  prompt: string,
  options: StartOptions = {},
): Promise<BgTaskMeta> {
  metrics.incrementAgyInvocations();
  ensureDir();

  const taskId = randomBytes(6).toString("hex");
  const builder = new AgyCommandBuilder();
  // Background tasks need full autonomy: agy print mode can't answer
  // permission prompts, so default to skipping them unless the caller opts out
  // or picked a `mode` (see defaultSkipPermissions).
  const finalSkipPermissions =
    options.skipPermissions ?? defaultSkipPermissions(options.mode);
  const { args, workingDir, stdin, streamJsonOutput } = await builder.build(
    prompt,
    {
      ...options,
      skipPermissions: options.readOnly ? false : finalSkipPermissions,
      logFile: agyLogPath(taskId),
      useStdinForLongPrompts: true,
      outputFormat: options.structuredOutput
        ? "stream-json"
        : options.outputFormat,
    },
  );
  // A long prompt goes in via stream-json input, which forces stream-json
  // stdout — keep it in <id>.out, separate from stderr, like structured tasks.
  const structured = Boolean(options.structuredOutput || streamJsonOutput);

  // agy appends to its --log-file; creating it first keeps it owner-only like
  // the other task files (it records the conversation).
  try {
    closeSync(openSync(agyLogPath(taskId), "a", PRIVATE_FILE_MODE));
  } catch {
    /* agy creates it itself */
  }

  // Opened inside the try, so a failure opening the second file (EMFILE,
  // permissions) still closes the first.
  let errFd: number | undefined;
  let outFd: number | undefined;
  try {
    errFd = openSync(logPath(taskId), "a", PRIVATE_FILE_MODE);
    outFd = structured
      ? openSync(outPath(taskId), "a", PRIVATE_FILE_MODE)
      : errFd;
    const child = spawn(CLI.COMMANDS.AGY, args, {
      cwd: workingDir,
      detached: true,
      stdio: ["pipe", outFd, errFd],
      env: process.env,
    });

    // Without an "error" listener a failed spawn (agy missing from PATH)
    // is an uncaught exception that takes the whole MCP server down.
    const spawnError = new Promise<Error>((resolve) =>
      child.once("error", resolve),
    );
    if (!child.pid) {
      const err = await spawnError;
      for (const p of [logPath(taskId), outPath(taskId)]) {
        try {
          unlinkSync(p);
        } catch {
          /* not created */
        }
      }
      throw new Error(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? ERROR_MESSAGES.AGY_NOT_FOUND
          : `Failed to start agy: ${err.message}`,
      );
    }
    child.on("error", (err) =>
      Logger.error(`Background task ${taskId} process error:`, err),
    );

    if (child.stdin) {
      child.stdin.on("error", (err) =>
        Logger.warn(`stdin write to bg task ${taskId} failed: ${err.message}`),
      );
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    }

    child.unref();

    const meta: BgTaskMeta = {
      taskId,
      pid: child.pid,
      state: "running",
      prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
      workingDir,
      model: options.model,
      // For diagnostics only; long values (the prompt) are cut like `prompt`
      // above instead of persisting the whole payload on disk.
      args: args.map((a) => truncateForLog(a) as string),
      startedAt: Date.now(),
      label: options.label,
      outputFormat: structured ? "stream-json" : "text",
    };

    // Track exit even though we're detached — works while the MCP server lives.
    child.on("exit", (code, signal) => {
      const current = readMeta(taskId);
      if (!current) return;
      current.state = settledState(current, code, signal);
      current.exitCode = code;
      current.finishedAt = current.finishedAt ?? Date.now();
      liftConversationId(current);
      writeMeta(current);
    });

    writeMeta(meta);
    return meta;
  } finally {
    // The child inherits the fds; we can close our handles.
    for (const fd of new Set([errFd, outFd])) {
      if (fd === undefined) continue;
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getBgTask(taskId: string): BgTaskMeta | null {
  const meta = readMeta(taskId);
  if (!meta) return null;
  return reconcile(meta);
}

export function listBgTasks(): BgTaskMeta[] {
  ensureDir();
  const entries = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  const tasks: BgTaskMeta[] = [];
  for (const e of entries) {
    const id = e.replace(/\.json$/, "");
    const meta = readMeta(id);
    if (meta) tasks.push(reconcile(meta));
  }
  return tasks.sort((a, b) => b.startedAt - a.startedAt);
}

export function tailLog(taskId: string, lines: number = 100): string {
  assertTaskId(taskId);
  const p = logPath(taskId);
  if (!existsSync(p)) return "";
  // For typical task logs (<few MB) just read fully then slice.
  // Bound: cap at 5MB read to be safe.
  const st = statSync(p);
  const cap = 5 * 1024 * 1024;
  if (st.size <= cap) {
    const all = readFileSync(p, "utf8");
    const arr = all.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  }
  // Large log: read tail chunk only.
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(cap);
    const read = readSync(fd, buf, 0, cap, st.size - cap);
    const text = buf.subarray(0, read).toString("utf8");
    const arr = text.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } finally {
    closeSync(fd);
  }
}

export function stopBgTask(
  taskId: string,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  assertTaskId(taskId);
  const meta = readMeta(taskId);
  if (!meta) return false;
  // Only signal a task we believe is still running: a finished task's PID may
  // already belong to an unrelated process.
  if (meta.state !== "running" || !isAlive(meta.pid)) {
    reconcile(meta);
    return false;
  }
  try {
    // The child was spawned detached, so it leads its own process group;
    // signal the group so agy's own subprocesses (shell commands, MCP
    // servers it started) stop too.
    try {
      process.kill(-meta.pid, signal);
    } catch {
      process.kill(meta.pid, signal);
    }
    meta.state = "killed";
    meta.finishedAt = Date.now();
    liftConversationId(meta);
    writeMeta(meta);
    return true;
  } catch (err) {
    Logger.warn(`Failed to kill ${meta.pid}: ${err}`);
    return false;
  }
}

export function removeBgTask(taskId: string): boolean {
  assertTaskId(taskId);
  const meta = readMeta(taskId);
  if (!meta) return false;
  if (meta.state === "running" && isAlive(meta.pid)) {
    // Refuse to delete a live task — caller must stop first.
    return false;
  }
  try {
    for (const p of [
      metaPath(taskId),
      logPath(taskId),
      outPath(taskId),
      agyLogPath(taskId),
    ]) {
      if (existsSync(p)) unlinkSync(p);
    }
    return true;
  } catch (err) {
    Logger.warn(`Failed to remove ${taskId}: ${err}`);
    return false;
  }
}
