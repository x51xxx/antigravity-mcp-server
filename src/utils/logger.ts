import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import { LOG_PREFIX } from "../constants.js";

const LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

// stdout carries the MCP JSON-RPC stream (stdio transport), so every level
// must go to stderr — console.log would corrupt the protocol as soon as a
// client lowered the log level to info or debug.
const LEVEL_CONSOLE_METHOD: Record<LoggingLevel, "warn" | "error"> = {
  debug: "error",
  info: "error",
  notice: "error",
  warning: "warn",
  error: "error",
  critical: "error",
  alert: "error",
  emergency: "error",
};

const MAX_LOGGED_STRING = 200;

/**
 * Copy of a value for logging with every long string cut down. Tool arguments
 * and argv carry whole prompts (code, diffs, file contents), which do not
 * belong in a client's log.
 */
export function truncateForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_LOGGED_STRING
      ? `${value.slice(0, MAX_LOGGED_STRING)}…[${value.length} chars]`
      : value;
  }
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((v) => truncateForLog(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, truncateForLog(v, depth + 1)]),
  );
}

export class Logger {
  private static currentLevel: LoggingLevel = "warning";

  static setLevel(level: LoggingLevel): void {
    this.currentLevel = level;
  }

  static getLevel(): LoggingLevel {
    return this.currentLevel;
  }

  private static shouldLog(level: LoggingLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.currentLevel];
  }

  private static formatMessage(level: LoggingLevel, message: string): string {
    return `${LOG_PREFIX} [${level.toUpperCase()}] ${message}`;
  }

  private static emit(
    level: LoggingLevel,
    message: string,
    ...args: any[]
  ): void {
    if (!this.shouldLog(level)) return;
    const consoleMethod = LEVEL_CONSOLE_METHOD[level];
    console[consoleMethod](this.formatMessage(level, message), ...args);
  }

  static log(message: string, ...args: any[]): void {
    this.emit("info", message, ...args);
  }
  static warn(message: string, ...args: any[]): void {
    this.emit("warning", message, ...args);
  }
  static error(message: string, ...args: any[]): void {
    this.emit("error", message, ...args);
  }
  static debug(message: string, ...args: any[]): void {
    this.emit("debug", message, ...args);
  }

  static toolInvocation(toolName: string, args: any): void {
    this.debug(
      `Args for tool '${toolName}':`,
      JSON.stringify(truncateForLog(args), null, 2),
    );
  }

  static commandExecution(
    command: string,
    args: string[],
    startTime: number,
  ): void {
    // Debug only, and truncated: argv carries the full prompt (code, diffs,
    // file contents), which does not belong in a client's log at warn level.
    const shown = args.map((a) => truncateForLog(a) as string);
    this.debug(
      `[${startTime}] Starting: ${command} ${shown.map((a) => `"${a}"`).join(" ")}`,
    );
  }

  static commandComplete(
    startTime: number,
    exitCode: number | null,
    outputLength?: number,
  ): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.debug(`[${elapsed}s] Process finished with exit code: ${exitCode}`);
    if (outputLength !== undefined) {
      this.debug(`Response: ${outputLength} chars`);
    }
  }

  static agyResponse(response: string, tokensUsed?: number): void {
    this.debug(`Antigravity response: ${response.substring(0, 200)}...`);
    if (tokensUsed) this.debug(`Tokens used: ${tokensUsed}`);
  }
}
