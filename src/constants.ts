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

// Known Antigravity CLI models (from `agy models`, CLI v1.5.9).
// `agy models` prints `<id>\t<display label>`; `--model` accepts either form,
// e.g. --model "Gemini 4 Hydrogen (High)" or --model gemini-4-hydrogen-high.
// A base ID without the effort suffix (gemini-4-hydrogen) plus `--effort` also
// works; a base *label* ("Gemini 4 Hydrogen") does not. Availability depends on
// the account plan — run the `list-models` tool for the live list.
export const MODELS = {
  // Gemini 4 Hydrogen — fast everyday coding; the implementer inside Orchestrator.
  GEMINI_4_HYDROGEN_LOW: "Gemini 4 Hydrogen (Low)",
  GEMINI_4_HYDROGEN_MEDIUM: "Gemini 4 Hydrogen (Medium)",
  GEMINI_4_HYDROGEN_HIGH: "Gemini 4 Hydrogen (High)",
  GEMINI_4_HYDROGEN_XHIGH: "Gemini 4 Hydrogen (XHigh)",
  // Gemini 4 Argon — deep reasoning; the planner in Orchestrator (Argon).
  GEMINI_4_ARGON_LOW: "Gemini 4 Argon (Low)",
  GEMINI_4_ARGON_MEDIUM: "Gemini 4 Argon (Medium)",
  GEMINI_4_ARGON_HIGH: "Gemini 4 Argon (High)",
  // Gemini 4 Carbon — maximum-depth reasoning (Ultra / Enterprise only).
  GEMINI_4_CARBON_LOW: "Gemini 4 Carbon (Low)",
  GEMINI_4_CARBON_MEDIUM: "Gemini 4 Carbon (Medium)",
  GEMINI_4_CARBON_HIGH: "Gemini 4 Carbon (High)",
  // Orchestrator — planner (Argon/Carbon) + Hydrogen implementer in one
  // conversation. Fixed thinking level: never pass --effort with it.
  ORCHESTRATOR_ARGON: "Orchestrator (Argon)",
  ORCHESTRATOR_CARBON: "Orchestrator (Carbon)",
  GEMINI_3_8_FLASH_LOW: "Gemini 3.8 Flash (Low)",
  GEMINI_3_8_FLASH_MEDIUM: "Gemini 3.8 Flash (Medium)",
  GEMINI_3_8_FLASH_HIGH: "Gemini 3.8 Flash (High)",
  CLAUDE_OPUS_5_5_LOW: "Claude Opus 5.5 (Low)",
  CLAUDE_OPUS_5_5_MEDIUM: "Claude Opus 5.5 (Medium)",
  CLAUDE_OPUS_5_5_HIGH: "Claude Opus 5.5 (High)",
  CLAUDE_SONNET_5_5_LOW: "Claude Sonnet 5.5 (Low)",
  CLAUDE_SONNET_5_5_MEDIUM: "Claude Sonnet 5.5 (Medium)",
  CLAUDE_SONNET_5_5_HIGH: "Claude Sonnet 5.5 (High)",
  // Scheduled for removal on 2026-11-18.
  GPT_OSS_120B_MEDIUM: "GPT-OSS 120B (Medium)",
} as const;

/**
 * What each model family is for, per https://antigravity.google/docs/models.
 * Keyed by the base model ID (the `agy models` ID without its effort suffix).
 * Only families the docs describe carry a purpose; the effort levels were
 * verified against CLI v1.5.9 (`--effort` rejects anything else per model).
 */
export const MODEL_FAMILIES: Record<
  string,
  { name: string; purpose?: string; efforts: readonly string[] }
> = {
  "gemini-4-hydrogen": {
    name: "Gemini 4 Hydrogen",
    purpose:
      "Fast everyday coding and maintenance (upgrades, boilerplate, tests, docs) where no separate planning phase is needed. Implementer inside Orchestrator.",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  "gemini-4-argon": {
    name: "Gemini 4 Argon",
    purpose:
      "Maximum reasoning depth on every step; the planner in Orchestrator (Argon).",
    efforts: ["low", "medium", "high"],
  },
  "gemini-4-carbon": {
    name: "Gemini 4 Carbon",
    purpose:
      "Maximum-depth reasoning (e.g. designing complex systems from scratch); the planner in Orchestrator (Carbon). Ultra / Enterprise only.",
    efforts: ["low", "medium", "high"],
  },
  "gemini-pro-orchestrator-g1-pro": {
    name: "Orchestrator (Argon)",
    purpose:
      "Long multi-step tasks: Argon plans and reviews (read-only phase), Hydrogen implements, builds, tests and reports back; control returns to the planner on repeated failures. Single agent, no parallel subagents. Fixed thinking level.",
    efforts: [],
  },
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    efforts: ["low", "medium", "high"],
  },
  "claude-opus-5-5": {
    name: "Claude Opus 5.5",
    efforts: ["low", "medium", "high"],
  },
  "claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    efforts: ["low", "medium", "high"],
  },
  "gpt-oss-120b": {
    name: "GPT-OSS 120B",
    purpose: "Scheduled for removal on 2026-11-18.",
    efforts: ["medium"],
  },
};

/** Every value `agy --effort` accepts; each model supports a subset. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Values of `agy --mode`. */
export const AGENT_MODES = ["accept-edits", "auto", "plan"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * Session-only settings overlay (`--settings`) for the read-only tools (plan,
 * review, digest, brainstorm). Since CLI 1.5.7 headless `-p` runs start in
 * Auto mode, which edits files without asking.
 * - `agentMode: ""` forces Default mode: a headless run cannot answer a
 *   permission prompt, so anything needing approval is auto-denied while the
 *   answer still goes to stdout (unlike `--mode plan`, which writes it into a
 *   plan artifact).
 * - `permissions.allow: []` replaces the user's allow-rules for this run only;
 *   otherwise a pre-approved command such as `git checkout` still executes
 *   (verified: it reverted an uncommitted change). Reading workspace files
 *   keeps working; shell commands, even read-only ones, are denied.
 */
/** Prompt line for read-only tools — see READ_ONLY_SETTINGS. */
export const READ_ONLY_PROMPT_NOTE =
  "Read-only run: you may read and search files with your file tools, but do NOT run shell commands or edit files — those calls are blocked, and a blocked call discards your whole answer.";

export const READ_ONLY_SETTINGS = JSON.stringify({
  agentMode: "",
  permissions: { allow: [] },
});

// The model this server documents as its default in tool descriptions, error
// hints and examples. It is deliberately NOT injected into argv: omitting the
// `model` argument still defers to the CLI's own default
// (`model` in ~/.gemini/antigravity-cli/settings.json). It drives the model
// hints in ERROR_SOLUTIONS; the README "Models" section names it too and must
// be updated by hand.
export const DEFAULT_MODEL: string = MODELS.GEMINI_4_HYDROGEN_HIGH;

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

// CLI Constants — verified against `agy --help` (Antigravity CLI v1.5.9)
export const CLI = {
  COMMANDS: {
    AGY: "agy",
  },
  FLAGS: {
    // Print mode (non-interactive, required for MCP)
    PRINT: "-p", // also: --print / --prompt
    PRINT_TIMEOUT: "--print-timeout", // Go duration string, e.g. "600s" (default 0s = no limit)

    // Model — accepts either column of `agy models` (id or display label)
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

    // Model tuning / behaviour
    EFFORT: "--effort", // low | medium | high | xhigh | max (subset per model)
    MODE: "--mode", // accept-edits | auto | plan
    SETTINGS: "--settings", // session-only settings.json overlay (JSON or path)
    OUTPUT_FORMAT: "--output-format", // text | json | stream-json

    // Not wired into any tool yet — reference only.
    INPUT_FORMAT: "--input-format", // text | stream-json
    JSON_SCHEMA: "--json-schema", // enforce structured output
    AGENT: "--agent", // agent for the session (see `agy agents`)
    PROJECT: "--project", // project ID or name for the session
    NEW_PROJECT: "--new-project",
    DISABLE_SLASH_COMMANDS: "--disable-slash-commands",
    REMOTE_AGENT: "--remote-agent", // run conversations on remote agents
  },
  SUBCOMMANDS: {
    MODELS: "models",
    AGENTS: "agents",
    CHANGELOG: "changelog",
    UPDATE: "update",
    INSTALL: "install",
    PLUGIN: "plugin",
    MCP: "mcp",
    ACP: "acp",
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
  effort?: string; // --effort
  mode?: string; // --mode

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
