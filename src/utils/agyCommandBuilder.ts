import { CLI } from "../constants.js";
import { Logger } from "./logger.js";
import { resolveWorkingDirectory } from "./workingDirResolver.js";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

/**
 * Options accepted by AgyCommandBuilder. Verified against `agy --help` v1.1.14.
 */
export interface AgyCommandBuilderOptions {
  /** Model id or display label from `agy models`, e.g. "Gemini 3.7 Flash (High)". */
  readonly model?: string;
  /** --dangerously-skip-permissions: auto-approve all tool permission requests. */
  readonly skipPermissions?: boolean;
  /** --sandbox: run with terminal restrictions enabled. */
  readonly sandbox?: boolean;
  readonly cd?: string;
  readonly workingDir?: string;
  /** Additional workspace directories (--add-dir, repeatable). */
  readonly addDirs?: string[];
  /** Native Antigravity conversation ID for `--conversation <id>`. */
  readonly conversationId?: string;
  /** --continue — resume the most recent conversation. */
  readonly continueLatest?: boolean;
  /** Print-mode timeout in milliseconds (converted to a Go duration for --print-timeout). */
  readonly timeoutMs?: number;
  /**
   * Custom --log-file path. When set, the file is NOT registered for cleanup —
   * the caller owns it (used by background tasks to parse the conversation ID
   * after the detached process exits).
   */
  readonly logFile?: string;

  // Internal
  readonly concisePrompt?: boolean;
  readonly useStdinForLongPrompts?: boolean;
}

export interface BuildResult {
  args: string[];
  tempFiles: string[];
  finalPrompt: string;
  useResume: boolean;
  workingDir?: string;
  /** Temp log file passed via --log-file — parse the conversation ID out of it. */
  logFile: string;
  /** Optional stdin payload — used for long prompts (>100KB). */
  stdin?: string;
}

/**
 * Builds Antigravity CLI argv lists.
 *
 * Resulting shape (in order):
 *   agy [--model LABEL]
 *       [--dangerously-skip-permissions] [--sandbox]
 *       [--continue | --conversation ID]
 *       [--add-dir D]...
 *       [--print-timeout 600s]
 *       --log-file /tmp/agy-mcp-XXXX.log
 *       -p '<prompt>'
 *
 * Print mode notes:
 * - `-p` with a value runs the prompt; bare `-p` reads the prompt from stdin.
 * - The conversation ID is not printed to stdout in print mode; it appears in
 *   the CLI log as "Print mode: conversation=<uuid>", so we always redirect
 *   the log to a temp file and parse it after the run.
 */
export class AgyCommandBuilder {
  private args: string[] = [];
  private tempFiles: string[] = [];
  private useResumeMode = false;
  private resolvedWorkingDir?: string;

  async build(
    prompt: string,
    options?: AgyCommandBuilderOptions,
  ): Promise<BuildResult> {
    this.args = [];
    this.tempFiles = [];
    this.useResumeMode = false;
    this.resolvedWorkingDir = undefined;

    this.validateOptions(options);

    // 1. Model — display label from `agy models`.
    if (options?.model) {
      this.args.push(CLI.FLAGS.MODEL, options.model);
    }

    // 2. Approvals & isolation.
    if (options?.skipPermissions) {
      this.args.push(CLI.FLAGS.SKIP_PERMISSIONS);
    }
    if (options?.sandbox) {
      this.args.push(CLI.FLAGS.SANDBOX);
    }

    // 3. Conversation resume.
    if (options?.conversationId) {
      this.args.push(CLI.FLAGS.CONVERSATION, options.conversationId);
      this.useResumeMode = true;
      Logger.debug(`Resume mode: --conversation ${options.conversationId}`);
    } else if (options?.continueLatest) {
      this.args.push(CLI.FLAGS.CONTINUE);
      this.useResumeMode = true;
      Logger.debug("Resume mode: --continue (most recent conversation)");
    }

    // 4. Working directory — agy has no --work-dir flag; the workspace is
    //    derived from the spawn cwd. Extra directories go via --add-dir.
    this.resolvedWorkingDir = resolveWorkingDirectory({
      workingDir: options?.workingDir || options?.cd,
      prompt,
    });
    if (this.resolvedWorkingDir) {
      Logger.debug(`Using spawn cwd: ${this.resolvedWorkingDir}`);
    }
    if (options?.addDirs && Array.isArray(options.addDirs)) {
      for (const d of options.addDirs) this.args.push(CLI.FLAGS.ADD_DIR, d);
    }

    // 5. Print timeout — agy expects a Go duration string (default "5m0s").
    //    We keep our own SIGTERM timeout slightly above it in the executor.
    if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
      const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
      this.args.push(CLI.FLAGS.PRINT_TIMEOUT, `${seconds}s`);
    }

    // 6. Log file — always redirected so we can recover the conversation ID.
    let logFile: string;
    if (options?.logFile) {
      logFile = options.logFile;
    } else {
      logFile = join(tmpdir(), `agy-mcp-${randomBytes(8).toString("hex")}.log`);
      this.tempFiles.push(logFile);
    }
    this.args.push(CLI.FLAGS.LOG_FILE, logFile);

    // 7. Final prompt.
    return this.handlePrompt(prompt, logFile, options);
  }

  private validateOptions(options?: AgyCommandBuilderOptions): void {
    if (options?.conversationId && options?.continueLatest) {
      throw new Error(
        "Cannot combine conversationId (--conversation) with continueLatest (--continue).",
      );
    }
  }

  private handlePrompt(
    prompt: string,
    logFile: string,
    options?: AgyCommandBuilderOptions,
  ): BuildResult {
    let finalPrompt = prompt;

    if (options?.concisePrompt) {
      finalPrompt = `Please provide a focused, concise response without unnecessary elaboration. ${prompt}`;
    }

    // agy accepts the prompt as the value of -p, OR reads it from stdin when
    // -p is passed without a value.
    const MAX_COMMAND_LINE_LENGTH = 100000;
    const useStdin =
      options?.useStdinForLongPrompts !== false &&
      finalPrompt.length > MAX_COMMAND_LINE_LENGTH;

    if (useStdin) {
      Logger.debug(
        `Prompt is ${finalPrompt.length} chars — sending via stdin (bare -p)`,
      );
      this.args.push(CLI.FLAGS.PRINT);
      return {
        args: this.args,
        tempFiles: this.tempFiles,
        finalPrompt,
        useResume: this.useResumeMode,
        workingDir: this.resolvedWorkingDir,
        logFile,
        stdin: finalPrompt,
      };
    }

    this.args.push(CLI.FLAGS.PRINT, finalPrompt);
    return {
      args: this.args,
      tempFiles: this.tempFiles,
      finalPrompt,
      useResume: this.useResumeMode,
      workingDir: this.resolvedWorkingDir,
      logFile,
    };
  }

  static cleanupTempFile(tempFile: string): void {
    try {
      unlinkSync(tempFile);
      Logger.debug(`Cleaned up temp file: ${tempFile}`);
    } catch {
      // Log file may not exist if agy failed before creating it.
    }
  }
}
