# Antigravity MCP Server

MCP (Model Context Protocol) server for [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) integration. Lets any MCP client (Claude Code, Claude Desktop, Cursor, etc.) delegate tasks to Antigravity's agentic CLI — with model selection (Gemini, Claude, GPT-OSS), conversation resume, and workspace controls.

A sibling of [@trishchuk/kimi-mcp-server](https://github.com/x51xxx/kimi-mcp-server), ported to the Antigravity CLI.

## Requirements

- Node.js >= 18
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) installed (`agy --version` works) and authenticated (run `agy` once interactively and sign in with your Google account)

## Installation

```bash
npm install -g @trishchuk/antigravity-mcp-server
```

Or run from source:

```bash
pnpm install && pnpm build
```

## MCP client configuration

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["-y", "@trishchuk/antigravity-mcp-server"],
      "env": {
        "AGY_MCP_CWD": "/path/to/your/project"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add antigravity -- npx -y @trishchuk/antigravity-mcp-server
```

## Tools

| Tool                                 | Description                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-antigravity`                    | Run a prompt through `agy` in print mode. Supports model override, session resume, `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`, dry-run. |
| `plan-antigravity`                   | Generate a structured implementation plan (JSON or markdown) without mutating anything.                                                                 |
| `review-changes`                     | Collect a git diff (working tree / vs base branch / specific commit) and run a structured code review.                                                  |
| `brainstorm`                         | Structured ideation (divergent, convergent, SCAMPER, design-thinking, lateral).                                                                         |
| `digest-antigravity`                 | Ingest many files/directories and answer a focused question using Antigravity's large model context.                                                    |
| `batch-antigravity`                  | Run multiple atomic tasks sequentially or in parallel (priority order, stop-on-error, concurrency cap).                                                 |
| `bg-antigravity`                     | Detached background tasks: start / status / tail / stop / remove / list. State persists in `~/.agy-mcp/bg/` across server restarts.                     |
| `delegate-antigravity`               | Delegate an implementation task into an isolated git worktree; poll status, then `collect` the diff for selective review.                               |
| `list-sessions`                      | List / delete / clear conversation sessions.                                                                                                            |
| `list-models`                        | List model labels currently available (`agy models`).                                                                                                   |
| `health`                             | Diagnose CLI installation, authentication, models, and session state.                                                                                   |
| `ping`, `Help`, `version`, `metrics` | Utilities.                                                                                                                                              |

Background and batch tools default to `--dangerously-skip-permissions` because print mode cannot answer interactive permission prompts; pass `skipPermissions: false` to opt out.

## Models

The `model` parameter takes either column of `agy models` — the **model ID** (`gemini-3.7-flash-high`) or the **display label** (`Gemini 3.7 Flash (High)`). As of Antigravity CLI v1.1.14:

| Model                                      | IDs                                  |
| ------------------------------------------ | ------------------------------------ |
| `Gemini 3.7 Flash (Low \| Medium \| High)` | `gemini-3.7-flash-{low,medium,high}` |
| `Gemini 3.6 Flash (Low \| Medium \| High)` | `gemini-3.6-flash-{low,medium,high}` |
| `Gemini 3.5 Flash (Low \| Medium \| High)` | `gemini-3.5-flash-{low,medium,high}` |
| `Gemini 3.1 Pro (Low \| High)`             | `gemini-3.1-pro-{low,high}`          |
| `Claude Sonnet 4.6 (Thinking)`             | `claude-sonnet-4-6`                  |
| `Claude Opus 4.6 (Thinking)`               | `claude-opus-4-6-thinking`           |
| `GPT-OSS 120B (Medium)`                    | `gpt-oss-120b-medium`                |

Labels and tiers change between CLI releases — use the `list-models` tool for the live list.

Omit `model` and the server passes no `--model` flag, so the CLI's own default applies (`"model"` in `~/.gemini/antigravity-cli/settings.json`). The label this server uses in its examples and hints is `Gemini 3.7 Flash (High)` — see `DEFAULT_MODEL` in `src/constants.ts`.

## Sessions and conversation resume

`ask-antigravity` supports multi-turn conversations:

```json
{
  "prompt": "Analyze src/auth.ts for security issues",
  "sessionId": "auth-review"
}
```

```json
{
  "prompt": "Now suggest fixes for the issues you found",
  "sessionId": "auth-review"
}
```

How it works: `agy` doesn't print its conversation ID to stdout in print mode, so the server passes `--log-file` to a temp file and parses `Print mode: conversation=<uuid>` from it. The next call with the same `sessionId` resumes via `agy --conversation <uuid>`.

You can also pass a native `conversationId` directly, or `continueLatest: true` for `agy --continue`.

Session storage is in-memory (lost on server restart). Configure with:

- `AGY_SESSION_TTL_MS` — session TTL (default 24h)
- `AGY_MAX_SESSIONS` — max stored sessions (default 50)
- `AGY_MCP_CWD` — default working directory for `agy` runs

### Known quirk

When resuming a conversation, agy print mode replays the previous assistant message before the new response. The server strips the replayed prefix automatically when it can (previous response under 1000 chars); for longer responses a leading echo may remain.

## Safety

- `skipPermissions: true` maps to `--dangerously-skip-permissions` — agy auto-approves all tool/command permission requests. Use deliberately.
- `sandbox: true` maps to `--sandbox` — terminal restrictions enabled.
- By default agy uses your configured permission rules (`/permissions` in interactive agy).

## Development

```bash
pnpm build          # tsc
pnpm lint           # tsc --noEmit
pnpm format         # prettier
```

## License

MIT
