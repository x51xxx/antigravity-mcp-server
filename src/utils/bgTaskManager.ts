import { spawn } from "child_process";
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
} from "./agyCommandBuilder.js";
import { Logger } from "./logger.js";
import { parseConversationIdFromLog } from "./agyExecutor.js";
import { metrics } from "./metrics.js";

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
 *     <taskId>.log     — merged stdout + stderr stream from the child
 *     <taskId>.agylog  — agy's own CLI log (--log-file) — conversation ID source
 */

const STATE_DIR = join(homedir(), ".agy-mcp", "bg");

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
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function metaPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.json`);
}

function logPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.log`);
}

function agyLogPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.agylog`);
}

function readMeta(taskId: string): BgTaskMeta | null {
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
  writeFileSync(metaPath(meta.taskId), JSON.stringify(meta, null, 2), "utf8");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

function liftConversationId(meta: BgTaskMeta): void {
  if (meta.conversationId) return;
  const id = parseConversationIdFromLog(agyLogPath(meta.taskId));
  if (id) meta.conversationId = id;
}

/**
 * Reconcile on-disk state with reality: if the meta says "running" but the PID
 * is gone, mark as completed/failed using the log tail.
 */
function reconcile(meta: BgTaskMeta): BgTaskMeta {
  if (meta.state !== "running") return meta;
  if (isAlive(meta.pid)) return meta;

  meta.state = "completed";
  meta.finishedAt = meta.finishedAt ?? Date.now();
  // We can't recover exit code post-mortem; leave as null and trust log tail.
  meta.exitCode = meta.exitCode ?? null;

  liftConversationId(meta);
  writeMeta(meta);
  return meta;
}

export interface StartOptions extends AgyCommandBuilderOptions {
  label?: string;
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
  // permission prompts, so default to skipping them unless caller opts out.
  const finalSkipPermissions =
    options.skipPermissions !== undefined ? options.skipPermissions : true;
  const { args, workingDir, stdin } = await builder.build(prompt, {
    ...options,
    skipPermissions: finalSkipPermissions,
    logFile: agyLogPath(taskId),
    useStdinForLongPrompts: true,
  });

  const logFd = openSync(logPath(taskId), "a");
  try {
    const child = spawn("agy", args, {
      cwd: workingDir,
      detached: true,
      stdio: ["pipe", logFd, logFd],
      env: process.env,
    });

    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.unref();

    const meta: BgTaskMeta = {
      taskId,
      pid: child.pid as number,
      state: "running",
      prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
      workingDir,
      model: options.model,
      args,
      startedAt: Date.now(),
      label: options.label,
    };

    // Track exit even though we're detached — works while the MCP server lives.
    child.on("exit", (code, signal) => {
      const current = readMeta(taskId);
      if (!current) return;
      current.state = signal ? "killed" : code === 0 ? "completed" : "failed";
      current.exitCode = code;
      current.finishedAt = Date.now();
      liftConversationId(current);
      writeMeta(current);
    });

    writeMeta(meta);
    return meta;
  } finally {
    // The child inherits the fd; we can close our handle.
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
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
    const text = buf.slice(0, read).toString("utf8");
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
  const meta = readMeta(taskId);
  if (!meta) return false;
  if (!isAlive(meta.pid)) {
    reconcile(meta);
    return false;
  }
  try {
    process.kill(meta.pid, signal);
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
  const meta = readMeta(taskId);
  if (!meta) return false;
  if (meta.state === "running" && isAlive(meta.pid)) {
    // Refuse to delete a live task — caller must stop first.
    return false;
  }
  try {
    if (existsSync(metaPath(taskId))) unlinkSync(metaPath(taskId));
    if (existsSync(logPath(taskId))) unlinkSync(logPath(taskId));
    if (existsSync(agyLogPath(taskId))) unlinkSync(agyLogPath(taskId));
    return true;
  } catch (err) {
    Logger.warn(`Failed to remove ${taskId}: ${err}`);
    return false;
  }
}
