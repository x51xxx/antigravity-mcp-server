import {
  CLI,
  AGENT_MODES,
  EFFORT_LEVELS,
  READ_ONLY_SETTINGS,
} from "../constants.js";
import { isOrchestratorModel } from "./modelList.js";
import { Logger } from "./logger.js";
import { resolveWorkingDirectory } from "./workingDirResolver.js";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

/**
 * Options accepted by AgyCommandBuilder. Verified against `agy --help` v1.5.9.
 */
export interface AgyCommandBuilderOptions {
  /** Model id or display label from `agy models`, e.g. "Gemini 4 Hydrogen (High)". */
  readonly model?: string;
  /**
   * --effort: reasoning effort. Valid levels depend on the model (see
   * MODEL_FAMILIES); Orchestrator models reject it entirely.
   */
  readonly effort?: string;
  /** --mode: accept-edits | auto | plan. */
  readonly mode?: string;
  /**
   * Force the CLI's Default agent mode via a `--settings` overlay so a
   * headless run cannot write files (writes are auto-denied). Headless runs
   * otherwise start in Auto mode since CLI 1.5.7 and edit freely.
   */
  readonly readOnly?: boolean;
  /** --output-format: text (default) | json | stream-json. */
  readonly outputFormat?: "text" | "json" | "stream-json";
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
  /**
   * The prompt goes in on stdin as `--input-format stream-json`, which forces
   * `--output-format stream-json`: stdout is NDJSON events, not plain text,
   * and must be parsed (summarizeStreamJson) by the caller.
   */
  streamJsonOutput?: boolean;
}

/**
 * Builds Antigravity CLI argv lists.
 *
 * Resulting shape (in order):
 *   agy [--model LABEL] [--effort LEVEL]
 *       [--mode MODE | --settings '{"agentMode":""}']
 *       [--dangerously-skip-permissions] [--sandbox]
 *       [--continue | --conversation ID]
 *       [--add-dir D]...
 *       [--print-timeout 600s] [--output-format FMT]
 *       --log-file /tmp/agy-mcp-XXXX.log
 *       -p '<prompt>'
 *
 * Print mode notes:
 * - `-p` with a value runs the prompt; bare `-p` reads the prompt from stdin.
 * - In text output the conversation ID is not printed to stdout; it appears in
 *   the CLI log (see parseConversationIdFromLog), so we always redirect the
 *   log to a temp file and parse it after the run. json / stream-json output
 *   carries it as `conversation_id`.
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

    // 1. Model — ID or display label from `agy models`, plus optional effort.
    if (options?.model) {
      this.args.push(CLI.FLAGS.MODEL, options.model);
    }
    if (options?.effort) {
      this.args.push(CLI.FLAGS.EFFORT, options.effort);
    }

    // 2. Agent mode, approvals & isolation.
    if (options?.mode) {
      this.args.push(CLI.FLAGS.MODE, options.mode);
    } else if (options?.readOnly) {
      this.args.push(CLI.FLAGS.SETTINGS, READ_ONLY_SETTINGS);
    }
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
    //    The prompt is deliberately NOT used for @path resolution here: by
    //    now it is the composed prompt (diffs, file contents, batch text), and
    //    an "@/other/repo/x" inside untrusted content must not move the cwd.
    //    Tools resolve @path from the user's own text and pass workingDir.
    this.resolvedWorkingDir = resolveWorkingDirectory({
      workingDir: options?.workingDir || options?.cd,
    });
    if (this.resolvedWorkingDir) {
      Logger.debug(`Using spawn cwd: ${this.resolvedWorkingDir}`);
    }
    if (options?.addDirs && Array.isArray(options.addDirs)) {
      for (const d of options.addDirs) this.args.push(CLI.FLAGS.ADD_DIR, d);
    }

    // 5. Print timeout — agy expects a Go duration string (default "0s" =
    //    no limit since CLI 1.2.x). We keep our own SIGTERM timeout slightly
    //    above it in the executor.
    if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
      const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
      this.args.push(CLI.FLAGS.PRINT_TIMEOUT, `${seconds}s`);
    }
    if (options?.outputFormat && options.outputFormat !== "text") {
      this.args.push(CLI.FLAGS.OUTPUT_FORMAT, options.outputFormat);
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
      throw invalidArguments(
        "Cannot combine conversationId (--conversation) with continueLatest (--continue).",
      );
    }
    if (
      options?.effort &&
      !(EFFORT_LEVELS as readonly string[]).includes(options.effort)
    ) {
      throw invalidArguments(
        `Invalid effort "${options.effort}". Expected one of: ${EFFORT_LEVELS.join(", ")}.`,
      );
    }
    if (
      options?.effort &&
      options.model &&
      isOrchestratorModel(options.model)
    ) {
      throw invalidArguments(
        `Orchestrator models have a fixed thinking level — omit effort (got "${options.effort}").`,
      );
    }
    if (options?.effort && options.model && /\)\s*$/.test(options.model)) {
      throw invalidArguments(
        `effort cannot be combined with a display label ("${options.model}"). Use a base model ID such as "gemini-4-hydrogen" (see list-models).`,
      );
    }
    if (
      options?.mode &&
      !(AGENT_MODES as readonly string[]).includes(options.mode)
    ) {
      throw invalidArguments(
        `Invalid mode "${options.mode}". Expected one of: ${AGENT_MODES.join(", ")}.`,
      );
    }
    if (options?.readOnly && options.skipPermissions) {
      throw invalidArguments(
        "readOnly cannot be combined with skipPermissions (--dangerously-skip-permissions).",
      );
    }
    if (options?.mode === "plan" && options.skipPermissions) {
      throw invalidArguments(
        'mode "plan" cannot be combined with skipPermissions (--dangerously-skip-permissions would auto-approve the actions plan mode is meant to hold back).',
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

    // Long prompts can't go on the command line (Linux caps a single argv
    // string at 128 KB, macOS the whole argv at ~1 MB). agy ≥1.5 no longer
    // reads a bare `-p` from stdin ("flag needs an argument: -p"); the only
    // stdin channel is `--input-format stream-json`, one NDJSON user event,
    // which requires `--output-format stream-json` and takes no -p at all.
    const MAX_COMMAND_LINE_LENGTH = 100000;
    const useStdin =
      options?.useStdinForLongPrompts !== false &&
      finalPrompt.length > MAX_COMMAND_LINE_LENGTH;

    if (useStdin) {
      Logger.debug(
        `Prompt is ${finalPrompt.length} chars — sending via stdin (stream-json input)`,
      );
      this.args.push(CLI.FLAGS.INPUT_FORMAT, "stream-json");
      if (options?.outputFormat !== "stream-json") {
        // build() already pushed --output-format for "json"; replace it.
        const i = this.args.indexOf(CLI.FLAGS.OUTPUT_FORMAT);
        if (i >= 0) this.args.splice(i, 2);
        this.args.push(CLI.FLAGS.OUTPUT_FORMAT, "stream-json");
      }
      return {
        args: this.args,
        tempFiles: this.tempFiles,
        finalPrompt,
        useResume: this.useResumeMode,
        workingDir: this.resolvedWorkingDir,
        logFile,
        stdin:
          JSON.stringify({ event: "user", message: { content: finalPrompt } }) +
          "\n",
        streamJsonOutput: true,
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

/**
 * Default for `--dangerously-skip-permissions` in headless tools (bg, batch,
 * delegate) when the caller did not say. Print mode cannot answer permission
 * prompts, so skipping them is the default — but an explicit `mode` is the
 * caller's chosen permission policy, and skip-permissions would override it.
 */
export function defaultSkipPermissions(mode?: string): boolean {
  return !mode;
}

/**
 * A caller passed options that cannot work together (or an unknown value).
 * The fixed prefix lets classifyError report it as invalid arguments rather
 * than as an agy failure with install/auth hints.
 */
function invalidArguments(message: string): Error {
  return new Error(`Invalid arguments: ${message}`);
}
