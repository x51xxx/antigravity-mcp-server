import { readFileSync } from "fs";
import { executeCommandDetailed, RetryOptions } from "./commandExecutor.js";
import { Logger } from "./logger.js";
import { CLI, ERROR_MESSAGES } from "../constants.js";
import { AgyCommandBuilder } from "./agyCommandBuilder.js";
import { metrics } from "./metrics.js";

export interface AgyExecutionResult {
  output: string; // stdout — main response
  stderr: string; // stderr — may contain status hints
  exitCode: number | null;
  /** Native conversation ID parsed from the CLI log (for --conversation resume). */
  conversationId?: string;
}

export interface AgyExecOptions {
  readonly model?: string;
  readonly skipPermissions?: boolean;
  readonly sandbox?: boolean;
  readonly cd?: string;
  readonly workingDir?: string;
  readonly timeoutMs?: number;
  readonly timeout?: number;
  readonly maxOutputBytes?: number;
  readonly retry?: RetryOptions;
  readonly useStdinForLongPrompts?: boolean;
  readonly addDirs?: string[];
  readonly conversationId?: string;
  readonly continueLatest?: boolean;
  readonly dryRun?: boolean;
}

const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Parse the conversation ID from the agy CLI log file. In print mode the CLI
 * logs lines like (formats vary by CLI version):
 *   printmode.go:173] Print mode: starting (..., conversationID="<uuid>")   [1.1.x]
 *   server.go:1074] Created conversation <uuid>                             [1.0.x, 1.1.x]
 *   printmode.go:147] Print mode: conversation=<uuid>, sending message      [1.0.x]
 *
 * On a resumed run only the `conversationID="<uuid>"` form appears — there is
 * no "Created conversation" line — so both patterns are needed.
 */
export function parseConversationIdFromLog(logFile: string): string | null {
  let content: string;
  try {
    content = readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const patterns = [
    /Print mode: conversation=([a-f0-9-]{36})/i,
    /Created conversation ([a-f0-9-]{36})/i,
    /conversationID="([a-f0-9-]{36})"/i,
    /Streaming conversation ([a-f0-9-]{36})/i,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Convenience wrapper: returns just stdout, throws on failure.
 */
export async function executeAgyCLI(
  prompt: string,
  options?: AgyExecOptions,
  onProgress?: (newOutput: string) => void,
): Promise<string> {
  const result = await executeAgy(
    prompt,
    { ...options, concise: true },
    onProgress,
  );
  return result.output;
}

/**
 * Full executor: returns stdout, stderr, exit code, and the native
 * conversation ID. Throws on hard failures with categorized messages so
 * callers can map to AgyError categories.
 */
export async function executeAgy(
  prompt: string,
  options?: AgyExecOptions & { concise?: boolean; [key: string]: any },
  onProgress?: (newOutput: string) => void,
): Promise<AgyExecutionResult> {
  metrics.incrementAgyInvocations();
  const builder = new AgyCommandBuilder();
  const timeoutMs =
    options?.timeout || options?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const { args, tempFiles, workingDir, stdin, logFile } = await builder.build(
    prompt,
    {
      ...options,
      timeoutMs,
      concisePrompt: Boolean(options?.concise),
      useStdinForLongPrompts: options?.useStdinForLongPrompts !== false,
    },
  );

  if (options?.dryRun) {
    for (const tf of tempFiles) AgyCommandBuilder.cleanupTempFile(tf);
    return {
      output: JSON.stringify([CLI.COMMANDS.AGY, ...args]),
      stderr: "",
      exitCode: 0,
    };
  }

  try {
    // Give the process a grace window beyond agy's own --print-timeout so the
    // CLI gets the chance to report its timeout before we SIGTERM it.
    const result = await executeCommandDetailed(CLI.COMMANDS.AGY, args, {
      onProgress,
      timeoutMs: timeoutMs + 15000,
      maxOutputBytes: options?.maxOutputBytes,
      retry: options?.retry,
      cwd: workingDir,
      stdin,
    });

    const conversationId = parseConversationIdFromLog(logFile) || undefined;

    if (!result.ok) {
      const errorMessage = result.stderr || result.stdout || "Unknown error";

      if (
        errorMessage.includes("command not found") ||
        errorMessage.includes("not found")
      ) {
        throw new Error(ERROR_MESSAGES.AGY_NOT_FOUND);
      }
      if (
        errorMessage.includes("authentication") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("not authenticated") ||
        errorMessage.includes("login")
      ) {
        throw new Error(ERROR_MESSAGES.AUTHENTICATION_FAILED);
      }
      if (
        errorMessage.includes("quota") ||
        errorMessage.includes("rate limit")
      ) {
        throw new Error("Rate limit exceeded. Please wait and try again");
      }
      if (
        errorMessage.includes("permission") ||
        errorMessage.includes("denied")
      ) {
        throw new Error(
          `Permission denied. Try skipPermissions:true: ${errorMessage}`,
        );
      }
      if (result.timedOut) {
        throw new Error(`Antigravity CLI timed out after ${timeoutMs}ms`);
      }

      throw new Error(
        `Antigravity CLI failed (exit ${result.code}): ${errorMessage}`,
      );
    }

    return {
      output: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      conversationId,
    };
  } catch (error) {
    Logger.error("Antigravity execution failed:", error);
    throw error;
  } finally {
    for (const tf of tempFiles) {
      AgyCommandBuilder.cleanupTempFile(tf);
    }
  }
}
