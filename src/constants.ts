// Logging
export const LOG_PREFIX = "[AGY-MCP]";

// Error messages
export const ERROR_MESSAGES = {
  TOOL_NOT_FOUND: "not found in registry",
  NO_PROMPT_PROVIDED:
    "Please provide a prompt for analysis. Reference files by path (e.g., 'explain what src/index.ts does') or ask general questions",
  QUOTA_EXCEEDED: "Rate limit exceeded",
  AUTHENTICATION_FAILED:
    "Authentication failed - run `agy` once interactively to sign in with your Google account",
  AGY_NOT_FOUND:
    "Antigravity CLI not found - install from https://antigravity.google/docs/cli-getting-started (binary `agy` in ~/.local/bin)",
} as const;

// Status messages
export const STATUS_MESSAGES = {
  PRINT_EXECUTING: "🔒 Executing Antigravity CLI in print mode...",
  AGY_RESPONSE: "Antigravity response:",
  AUTHENTICATION_SUCCESS: "✅ Authentication successful",
  PROCESSING_START:
    "🔍 Starting analysis (may take 5-15 minutes for large codebases)",
  PROCESSING_CONTINUE: "⏳ Still processing...",
  PROCESSING_COMPLETE: "✅ Analysis completed successfully",
} as const;

// Known Antigravity CLI model labels (from `agy models`, CLI v1.0.7).
// The CLI accepts the full display label, e.g. --model "Gemini 3.5 Flash (High)".
// Run `agy models` to see the current list — labels change between releases.
export const MODELS = {
  GEMINI_3_5_FLASH_LOW: "Gemini 3.5 Flash (Low)",
  GEMINI_3_5_FLASH_MEDIUM: "Gemini 3.5 Flash (Medium)",
  GEMINI_3_5_FLASH_HIGH: "Gemini 3.5 Flash (High)",
  GEMINI_3_1_PRO_LOW: "Gemini 3.1 Pro (Low)",
  GEMINI_3_1_PRO_HIGH: "Gemini 3.1 Pro (High)",
  CLAUDE_SONNET_4_6_THINKING: "Claude Sonnet 4.6 (Thinking)",
  CLAUDE_OPUS_4_6_THINKING: "Claude Opus 4.6 (Thinking)",
  GPT_OSS_120B_MEDIUM: "GPT-OSS 120B (Medium)",
} as const;

// MCP Protocol Constants
export const PROTOCOL = {
  ROLES: {
    USER: "user",
    ASSISTANT: "assistant",
    TOOL: "tool",
  },
  CONTENT_TYPES: {
    TEXT: "text",
  },
  STATUS: {
    SUCCESS: "success",
    ERROR: "error",
    FAILED: "failed",
    REPORT: "report",
  },
  NOTIFICATIONS: {
    PROGRESS: "notifications/progress",
  },
  KEEPALIVE_INTERVAL: 25000, // 25 seconds
} as const;

// CLI Constants — verified against `agy --help` (Antigravity CLI v1.0.7)
export const CLI = {
  COMMANDS: {
    AGY: "agy",
  },
  FLAGS: {
    // Print mode (non-interactive, required for MCP)
    PRINT: "-p", // also: --print / --prompt
    PRINT_TIMEOUT: "--print-timeout", // Go duration string, e.g. "5m0s" (default 5m)

    // Model — accepts a display label from `agy models`
    MODEL: "--model",

    // Conversations
    CONTINUE: "--continue", // resume the most recent conversation
    CONVERSATION: "--conversation", // resume a previous conversation by ID

    // Workspace
    ADD_DIR: "--add-dir", // add a directory to the workspace (repeatable)

    // Approvals / isolation
    SKIP_PERMISSIONS: "--dangerously-skip-permissions", // auto-approve all tool calls
    SANDBOX: "--sandbox", // run with terminal restrictions

    // Diagnostics
    LOG_FILE: "--log-file", // override CLI log file path (we use this to capture the conversation ID)
    HELP: "--help",
    VERSION: "--version",
  },
  SUBCOMMANDS: {
    MODELS: "models",
    CHANGELOG: "changelog",
    UPDATE: "update",
    PLUGIN: "plugin",
  },
  ENV_VARS: {
    AGY_MCP_CWD: "AGY_MCP_CWD", // Primary: set in MCP client configuration
    PWD: "PWD",
    INIT_CWD: "INIT_CWD",
  },
} as const;

// Tool argument interface — superset of every tool's schema for type-safe dispatch.
export interface ToolArguments {
  prompt?: string;
  model?: string;
  skipPermissions?: boolean | string; // --dangerously-skip-permissions
  sandbox?: boolean | string; // --sandbox
  cd?: string; // Working directory (alias of workingDir)
  workingDir?: string; // Working directory for spawn cwd

  // Session management
  sessionId?: string; // Internal session id (workspace-isolated)
  conversationId?: string; // Native Antigravity conversation id passed to --conversation
  resetSession?: boolean; // Clear session before run
  continueLatest?: boolean; // --continue (most recent conversation)

  // Workspace
  addDirs?: string[]; // --add-dir (repeatable)

  // Misc
  timeout?: number;
  includeMetadata?: boolean;
  responseMode?: "clean" | "full";
  message?: string; // for ping
  verbose?: boolean; // for health

  // Brainstorming
  methodology?: string;
  domain?: string;
  constraints?: string;
  existingContext?: string;
  ideaCount?: number;
  includeAnalysis?: boolean;

  // Review
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  title?: string;

  // List-sessions
  action?: "list" | "delete" | "clear";

  [key: string]:
    | string
    | boolean
    | number
    | string[]
    | Record<string, any>
    | undefined
    | any;
}
