/**
 * Structured error types for Antigravity MCP server.
 * Categories with friendly titles, descriptions, and recommended fixes.
 */

export enum ErrorCategory {
  CLI_NOT_FOUND = "CLI_NOT_FOUND",
  AUTHENTICATION = "AUTHENTICATION",
  MODEL = "MODEL",
  RATE_LIMIT = "RATE_LIMIT",
  TIMEOUT = "TIMEOUT",
  PERMISSION = "PERMISSION",
  NETWORK = "NETWORK",
  SESSION = "SESSION",
  UNKNOWN = "UNKNOWN",
}

export const ERROR_MESSAGES: Record<
  ErrorCategory,
  { title: string; description: string }
> = {
  [ErrorCategory.CLI_NOT_FOUND]: {
    title: "Antigravity CLI Not Found",
    description: "Antigravity CLI (agy) is not installed or not in PATH.",
  },
  [ErrorCategory.AUTHENTICATION]: {
    title: "Authentication Failed",
    description: "Google account login is required.",
  },
  [ErrorCategory.MODEL]: {
    title: "Model Error",
    description: "The requested model is unavailable or the label is wrong.",
  },
  [ErrorCategory.RATE_LIMIT]: {
    title: "Rate Limit Exceeded",
    description: "Too many requests. Please wait and try again.",
  },
  [ErrorCategory.TIMEOUT]: {
    title: "Request Timeout",
    description: "Operation took longer than expected.",
  },
  [ErrorCategory.PERMISSION]: {
    title: "Permission Error",
    description: "Operation blocked by tool permission prompts.",
  },
  [ErrorCategory.NETWORK]: {
    title: "Network Error",
    description: "Failed to connect to the Antigravity backend.",
  },
  [ErrorCategory.SESSION]: {
    title: "Session Error",
    description: "Conversation is invalid, expired, or not found.",
  },
  [ErrorCategory.UNKNOWN]: {
    title: "Unknown Error",
    description: "An unexpected error occurred.",
  },
};

export const ERROR_SOLUTIONS: Record<ErrorCategory, string[]> = {
  [ErrorCategory.CLI_NOT_FOUND]: [
    "Install Antigravity CLI: https://antigravity.google/docs/cli-getting-started",
    "Verify installation: `agy --version`",
    "Check PATH includes `~/.local/bin` (run `agy install` to configure)",
  ],
  [ErrorCategory.AUTHENTICATION]: [
    "Run `agy` once interactively and sign in with your Google account",
    'Verify auth works: `agy -p "say OK"`',
  ],
  [ErrorCategory.MODEL]: [
    "Omit the model parameter to use your Antigravity CLI default",
    'Use the exact display label from `agy models`, e.g. "Gemini 3.5 Flash (High)"',
    "Labels change between CLI releases — re-check after `agy update`",
  ],
  [ErrorCategory.RATE_LIMIT]: [
    "Wait a few minutes before retrying",
    "Consider using a smaller / faster model (e.g. Gemini 3.5 Flash (Low))",
  ],
  [ErrorCategory.TIMEOUT]: [
    "Increase timeout: `timeout: 600000` (10 minutes)",
    "Simplify request or break into smaller parts",
    "Check network connectivity",
  ],
  [ErrorCategory.PERMISSION]: [
    "Use `skipPermissions: true` to auto-approve tool calls (use with care)",
    "Add allow-rules via `/permissions` in interactive agy, or in ~/.gemini/antigravity-cli/settings.json",
  ],
  [ErrorCategory.NETWORK]: [
    "Check internet connection",
    "Verify firewall / proxy settings",
    "Try again later — the Antigravity backend may be experiencing issues",
  ],
  [ErrorCategory.SESSION]: [
    "Conversation may have expired or been archived",
    "Use `list-sessions` to check active sessions",
    "Use `resetSession: true` to start fresh",
  ],
  [ErrorCategory.UNKNOWN]: [
    "Check Antigravity CLI: `agy --version`",
    "Run `agy` interactively to verify authentication",
    "Try a simpler query to isolate the issue",
    "Use `health` tool to diagnose",
  ],
};

export class AgyError extends Error {
  public readonly category: ErrorCategory;
  public readonly originalError?: Error;
  public readonly context?: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    message?: string,
    originalError?: Error,
    context?: Record<string, unknown>,
  ) {
    const info = ERROR_MESSAGES[category];
    super(message || info.description);
    this.name = "AgyError";
    this.category = category;
    this.originalError = originalError;
    this.context = context;
  }

  get title(): string {
    return ERROR_MESSAGES[this.category].title;
  }

  get solutions(): string[] {
    return ERROR_SOLUTIONS[this.category];
  }

  toUserFriendlyString(): string {
    const lines: string[] = [];
    lines.push(`**${this.title}**: ${this.message}`);
    lines.push("");
    lines.push("**Solutions:**");
    for (const s of this.solutions) lines.push(`- ${s}`);
    return lines.join("\n");
  }
}

export function classifyError(errorMessage: string): ErrorCategory {
  const message = errorMessage.toLowerCase();

  if (
    message.includes("model not found") ||
    message.includes("invalid model") ||
    message.includes("unsupported model") ||
    message.includes("model is not available") ||
    message.includes("model not available") ||
    /\bmodel\b.{0,50}\b(?:fail|error|reject|unavailable|unknown)\b/.test(
      message,
    ) ||
    /\b(?:fail|error|reject|unavailable|unknown)\b.{0,50}\bmodel\b/.test(
      message,
    )
  ) {
    return ErrorCategory.MODEL;
  }

  if (
    message.includes("command not found") ||
    message.includes("agy: not found") ||
    message.includes("agy not found") ||
    message.includes("antigravity cli not found") ||
    message.includes("enoent")
  ) {
    return ErrorCategory.CLI_NOT_FOUND;
  }

  if (
    message.includes("authentication") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("please login") ||
    message.includes("not authenticated")
  ) {
    return ErrorCategory.AUTHENTICATION;
  }

  if (
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("too many requests") ||
    message.includes("429")
  ) {
    return ErrorCategory.RATE_LIMIT;
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("etimedout")
  ) {
    return ErrorCategory.TIMEOUT;
  }

  if (
    message.includes("permission denied") ||
    message.includes("access denied") ||
    message.includes("operation not permitted") ||
    message.includes("not approved")
  ) {
    return ErrorCategory.PERMISSION;
  }

  if (
    message.includes("network") ||
    message.includes("connect") ||
    message.includes("econnrefused") ||
    message.includes("enotfound")
  ) {
    return ErrorCategory.NETWORK;
  }

  if (
    message.includes("session") ||
    message.includes("expired") ||
    message.includes("conversation")
  ) {
    return ErrorCategory.SESSION;
  }

  return ErrorCategory.UNKNOWN;
}

export function createAgyError(
  error: Error | string,
  context?: Record<string, unknown>,
): AgyError {
  const message = error instanceof Error ? error.message : error;
  const category = classifyError(message);
  const originalError = error instanceof Error ? error : undefined;
  return new AgyError(category, message, originalError, context);
}

export function formatErrorForUser(error: Error | string | AgyError): string {
  if (error instanceof AgyError) return error.toUserFriendlyString();
  return createAgyError(error).toUserFriendlyString();
}

export function isRetryableError(error: AgyError | ErrorCategory): boolean {
  const category = error instanceof AgyError ? error.category : error;
  return [
    ErrorCategory.RATE_LIMIT,
    ErrorCategory.TIMEOUT,
    ErrorCategory.NETWORK,
  ].includes(category);
}
