import spawn from "cross-spawn";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { Logger } from "./logger.js";

/**
 * The abort signal of the MCP request currently being served. Set once per
 * tool call (see index.ts) and picked up by every foreground process spawned
 * underneath it, so a client cancelling a call (notifications/cancelled)
 * stops the agy/git processes it started instead of leaving them running.
 * Detached background tasks (bgTaskManager) are deliberately not tied to it.
 */
const abortContext = new AsyncLocalStorage<AbortSignal>();

export function runWithAbortSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return signal ? abortContext.run(signal, fn) : fn();
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  partialStdout?: string;
  /** The binary could not be spawned (ENOENT). */
  spawnNotFound?: boolean;
  /** The MCP client cancelled the request and the process was killed. */
  aborted?: boolean;
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number;
  retryOn: ("timeout" | "exit_nonzero" | "spawn_error" | "transient")[];
}

export interface ExecuteOptions {
  onProgress?: (newOutput: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * stderr kept in memory; beyond it the oldest output is dropped (the end —
   * where agy prints AGY_ERROR and the final error — is what matters).
   */
  maxStderrBytes?: number;
  retry?: RetryOptions;
  cwd?: string;
  /**
   * Optional content to write to the child's stdin and then close.
   * Used for piping prompts when --print -p is not desirable.
   */
  stdin?: string;
}

/**
 * Execute a command with streaming output and structured error handling
 */
export async function executeCommandDetailed(
  command: string,
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  const {
    onProgress,
    timeoutMs = 600000,
    maxOutputBytes = 50 * 1024 * 1024, // 50MB default
    maxStderrBytes = 1024 * 1024, // 1MB default
    retry,
    cwd,
    stdin,
  } = options;

  let attempt = 0;
  const maxAttempts = retry?.attempts || 1;

  while (attempt < maxAttempts) {
    attempt++;
    const result = await executeOnce(command, args, {
      onProgress,
      timeoutMs,
      maxOutputBytes,
      maxStderrBytes,
      cwd,
      stdin,
    });

    if (result.ok || result.aborted) return result;

    const isTransient = result.code === 75; // EX_TEMPFAIL convention
    const shouldRetry =
      retry &&
      ((result.timedOut && retry.retryOn.includes("timeout")) ||
        (result.code !== 0 &&
          result.code !== null &&
          retry.retryOn.includes("exit_nonzero")) ||
        (isTransient && retry.retryOn.includes("transient")) ||
        (result.code === null &&
          !result.signal &&
          retry.retryOn.includes("spawn_error")));

    if (!shouldRetry || attempt >= maxAttempts) return result;

    const delay = retry.backoffMs * Math.pow(2, attempt - 1);
    Logger.warn(
      `Retrying command after ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error("Unexpected retry loop exit");
}

/**
 * How long to wait for stdout/stderr to close after the child has exited. A
 * process the child left behind (e.g. something agy started in the
 * background) can inherit the pipes and keep them open indefinitely.
 */
const STDIO_CLOSE_GRACE_MS = 2000;
/** SIGTERM → SIGKILL escalation delay. */
const KILL_ESCALATION_MS = 5000;

/**
 * On POSIX every foreground child gets its own process group, so a timeout or
 * cancel can signal the whole tree (agy and whatever it spawned), not just the
 * direct child. Windows has no process groups; there the child alone is killed.
 */
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Process groups of running foreground children, stopped if the server exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pgid of liveGroups) {
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });
}

async function executeOnce(
  command: string,
  args: string[],
  {
    onProgress,
    timeoutMs,
    maxOutputBytes,
    maxStderrBytes,
    cwd,
    stdin,
  }: Omit<ExecuteOptions, "retry">,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const abortSignal = abortContext.getStore();
    if (abortSignal?.aborted) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: "Cancelled by the MCP client",
        timedOut: false,
        aborted: true,
      });
      return;
    }
    // spawn reports a missing cwd as ENOENT, indistinguishable from a missing
    // binary — check it first so the error names the real problem.
    if (cwd && !existsSync(cwd)) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: `Working directory does not exist: ${cwd}`,
        timedOut: false,
      });
      return;
    }
    Logger.commandExecution(command, args, startTime);

    const childProcess = spawn(command, args, {
      env: process.env,
      shell: false,
      // Windows: agy gets a hidden console instead of a visible window when the
      // server has none (GUI clients), and its tool commands share it.
      windowsHide: true,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      detached: USE_PROCESS_GROUPS,
      ...(cwd ? { cwd } : {}),
    });
    const pid = childProcess.pid;
    if (USE_PROCESS_GROUPS && pid) trackGroup(pid);

    if (stdin !== undefined && childProcess.stdin) {
      // A child that exits before reading all of stdin raises EPIPE on this
      // stream; without a listener that is an uncaught error that kills the
      // whole MCP server. The exit code still reports the failure.
      childProcess.stdin.on("error", (err) =>
        Logger.warn(`stdin write to ${command} failed: ${err.message}`),
      );
      childProcess.stdin.write(stdin);
      childProcess.stdin.end();
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalStdoutBytes = 0;
    let keptStderrBytes = 0;
    let droppedStderrBytes = 0;
    let isResolved = false;
    let outputExceeded = false;
    let killedForTimeout = false;
    let killedForAbort = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    /** Signal the child's whole process group (POSIX) or the child itself. */
    const killTree = (signal: NodeJS.Signals): void => {
      if (USE_PROCESS_GROUPS && pid) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          /* group already gone — fall through to the direct child */
        }
      }
      childProcess.kill(signal);
    };

    /** SIGTERM now, SIGKILL if the tree is still around after the delay. */
    const terminate = (reason: string): void => {
      killTree("SIGTERM");
      if (escalationTimer) return;
      escalationTimer = setTimeout(() => {
        if (!isResolved) {
          Logger.error(
            `${command} did not terminate (${reason}), sending SIGKILL`,
          );
          killTree("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      escalationTimer.unref();
    };

    const onAbort = () => {
      if (isResolved) return;
      killedForAbort = true;
      Logger.warn(`Request cancelled by client, stopping ${command}`);
      terminate("cancelled");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        killedForTimeout = true;
        Logger.warn(`Process timeout after ${timeoutMs}ms, sending SIGTERM`);
        terminate("timeout");
      }
    }, timeoutMs || 600000);

    const finish = (result: CommandResult): void => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (pid) liveGroups.delete(pid);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const finishFromExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr =
        (droppedStderrBytes
          ? `[… ${droppedStderrBytes} earlier bytes of stderr dropped …]\n`
          : "") + Buffer.concat(stderrChunks).toString("utf8");
      Logger.commandComplete(startTime, code, stdout.length);
      finish({
        ok: code === 0 && !outputExceeded,
        code,
        signal: signal || undefined,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        // Only our own timer counts as a timeout — an output-cap kill or an
        // external signal is not one.
        timedOut: killedForTimeout,
        aborted: killedForAbort || undefined,
        partialStdout: outputExceeded ? stdout : undefined,
      });
    };

    childProcess.stdout?.on("data", (data: Buffer) => {
      if (maxOutputBytes && totalStdoutBytes + data.length > maxOutputBytes) {
        if (!outputExceeded) {
          outputExceeded = true;
          Logger.warn(
            `Output exceeded ${maxOutputBytes} bytes, stopping collection`,
          );
          terminate("output cap");
        }
        return;
      }
      stdoutChunks.push(data);
      totalStdoutBytes += data.length;
      if (onProgress) onProgress(data.toString("utf8"));
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
      keptStderrBytes += data.length;
      // Keep only the tail: drop whole chunks from the front, then trim the
      // first remaining chunk to the limit.
      if (maxStderrBytes && keptStderrBytes > maxStderrBytes) {
        while (
          stderrChunks.length > 1 &&
          keptStderrBytes - stderrChunks[0].length >= maxStderrBytes
        ) {
          const head = stderrChunks.shift()!;
          keptStderrBytes -= head.length;
          droppedStderrBytes += head.length;
        }
        const excess = keptStderrBytes - maxStderrBytes;
        if (excess > 0) {
          stderrChunks[0] = stderrChunks[0].subarray(excess);
          keptStderrBytes -= excess;
          droppedStderrBytes += excess;
        }
      }
    });

    childProcess.on("error", (error) => {
      if (isResolved) return;
      Logger.error(`Process error:`, error);
      const notFound =
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        (!cwd || existsSync(cwd));
      finish(
        notFound
          ? {
              ok: false,
              code: null,
              stdout: "",
              stderr: `Command '${command}' not found. Is it installed and in PATH?`,
              timedOut: false,
              spawnNotFound: true,
            }
          : {
              ok: false,
              code: null,
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: error.message,
              timedOut: false,
            },
      );
    });

    // Normally "close" (all stdio drained) follows "exit" right away. If a
    // leftover process still holds the pipes, stop waiting after a grace
    // period and return what was collected.
    childProcess.on("exit", (code, signal) => {
      if (isResolved) return;
      graceTimer = setTimeout(() => {
        if (isResolved) return;
        Logger.warn(
          `${command} exited but its output pipes stayed open (a leftover child process?); not waiting for them`,
        );
        childProcess.stdout?.destroy();
        childProcess.stderr?.destroy();
        finishFromExit(code, signal);
      }, STDIO_CLOSE_GRACE_MS);
      graceTimer.unref();
    });

    childProcess.on("close", (code, signal) => {
      if (isResolved) return;
      finishFromExit(code, signal);
    });
  });
}

/**
 * Backward compatible wrapper that returns stdout string
 */
export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (newOutput: string) => void,
  timeoutMs: number = 600000,
): Promise<string> {
  const result = await executeCommandDetailed(command, args, {
    onProgress,
    timeoutMs,
  });
  if (!result.ok) {
    const errorMessage = result.stderr || "Unknown error";
    throw new Error(
      result.timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : `Command failed with exit code ${result.code}: ${errorMessage}`,
    );
  }
  return result.stdout;
}
