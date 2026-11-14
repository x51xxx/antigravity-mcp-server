import { readFileSync } from "fs";
import { executeCommandDetailed, RetryOptions } from "./commandExecutor.js";
import { Logger } from "./logger.js";
import { CLI, ERROR_MESSAGES } from "../constants.js";
import { AgyCommandBuilder } from "./agyCommandBuilder.js";
import { metrics } from "./metrics.js";
import { summarizeStreamJson } from "./streamJson.js";

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
  /** --effort (subset per model; never with Orchestrator). */
  readonly effort?: string;
  /** --mode accept-edits | auto | plan. */
  readonly mode?: string;
  /** Force Default agent mode so the run cannot write files. */
  readonly readOnly?: boolean;
}

const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Parse the conversation ID from the agy CLI log file. In print mode the CLI
 * logs lines like (formats vary by CLI version):
 *   printmode.go:173] Print mode: starting (..., conversationID="<uuid>")   [1.1.x–1.5.x]
 *   server.go:1074] Created conversation <uuid>                             [1.0.x–1.5.x]
 *   printmode.go:147] Print mode: conversation=<uuid>, sending message      [1.0.x, 1.5.x resume]
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
 * Extract the structured `AGY_ERROR: {...}` line that headless runs print on
 * stderr (exit code 3) when a turn ends on a model/agent failure or a print
 * timeout. Returns the parsed object, or null when there is none.
 */
export function parseAgyErrorLine(
  stderr: string,
): Record<string, unknown> | null {
  // Other log lines can mention "AGY_ERROR:" too; take the first one that
  // actually carries a JSON object.
  for (const line of stderr.split("\n")) {
    const at = line.indexOf("AGY_ERROR:");
    if (at < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(at + "AGY_ERROR:".length).trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Turn a failed agy run into one error message. Order matters: a timeout or a
 * missing binary is decided by how the process ended, not by words in its
 * output (stderr routinely mentions "permission", "login" or "not found" for
 * unrelated reasons — e.g. a model that was "not found").
 */
export function describeAgyFailure(r: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnNotFound?: boolean;
  aborted?: boolean;
  timeoutMs: number;
}): string {
  if (r.spawnNotFound) return ERROR_MESSAGES.AGY_NOT_FOUND;
  if (r.aborted)
    return "Cancelled by the MCP client; the agy process was stopped.";
  if (r.timedOut) return `Antigravity CLI timed out after ${r.timeoutMs}ms`;

  const raw = (r.stderr || r.stdout || "Unknown error").trim();
  const agyError = parseAgyErrorLine(r.stderr);
  // Model-selection errors (bad model, unsupported effort) — exit 1 with an
  // "error: invalid model selection ..." line; keep the CLI's own wording.
  const modelErr = raw.match(/invalid model selection[^\n]*/i);
  if (modelErr) return `Model error: ${modelErr[0]}`;

  if (/print timeout after/i.test(raw)) {
    return `Antigravity CLI print timeout reached: ${raw}`;
  }
  if (agyError) {
    const msg =
      (agyError.message as string) ||
      (agyError.error as string) ||
      JSON.stringify(agyError);
    return `Antigravity agent error (exit ${r.code}): ${msg}`;
  }
  const lower = raw.toLowerCase();
  if (
    lower.includes("not authenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("please login") ||
    lower.includes("sign in")
  ) {
    return `${ERROR_MESSAGES.AUTHENTICATION_FAILED}: ${raw}`;
  }
  if (lower.includes("quota") || lower.includes("rate limit")) {
    return `Rate limit exceeded. Please wait and try again: ${raw}`;
  }
  return `Antigravity CLI failed (exit ${r.code}): ${raw}`;
}

/**
 * Text to show when a run succeeded but printed nothing. The usual cause is a
 * denied tool permission (e.g. a read-only run that tried to write), which agy
 * explains on stderr with exit code 0 — surface that instead of a blank.
 */
export function emptyResponseNote(stderr: string): string {
  const hint = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("AGY_ERROR:"))
    .pop();
  return hint ? `(empty response — agy: ${hint})` : "(empty response)";
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
  return result.output.trim()
    ? result.output
    : emptyResponseNote(result.stderr);
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
  // Foreground runs always carry a timeout: the tool schemas reject 0 and
  // negative values, and a non-positive value here falls back to the default
  // rather than becoming an instant kill (timeoutMs + 15s grace below).
  const requested = options?.timeout ?? options?.timeoutMs;
  const timeoutMs =
    typeof requested === "number" && requested > 0
      ? requested
      : DEFAULT_TIMEOUT_MS;
  const { args, tempFiles, workingDir, stdin, logFile, streamJsonOutput } =
    await builder.build(prompt, {
      ...options,
      timeoutMs,
      concisePrompt: Boolean(options?.concise),
      useStdinForLongPrompts: options?.useStdinForLongPrompts !== false,
    });

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

    let conversationId = parseConversationIdFromLog(logFile) || undefined;

    // Long prompts went in as stream-json, so stdout is NDJSON. Unwrap it to
    // the plain answer callers expect. In this mode a print timeout exits 0;
    // the failure is only visible in the result event (finished_reason).
    let stdout = result.stdout;
    if (streamJsonOutput && result.ok) {
      const summary = summarizeStreamJson(result.stdout);
      const r = summary.result;
      conversationId ||= summary.conversationId;
      if (!r || r.status !== "SUCCESS" || r.finishedReason) {
        const why = describeAgyFailure({
          code: result.code === 0 ? 3 : result.code,
          stdout: "",
          stderr: result.stderr,
          timedOut: false,
          timeoutMs,
        });
        throw new Error(
          r?.error && !why.includes(r.error) ? `${why}\n${r.error}` : why,
        );
      }
      stdout = r.response ?? summary.lastText;
    }

    if (!result.ok) {
      throw new Error(
        describeAgyFailure({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          spawnNotFound: result.spawnNotFound,
          aborted: result.aborted,
          timeoutMs,
        }),
      );
    }

    return {
      output: stdout,
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
