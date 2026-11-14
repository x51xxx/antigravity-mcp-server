# Antigravity MCP Server

MCP (Model Context Protocol) server for [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) integration. Lets any MCP client (Claude Code, Claude Desktop, Cursor, etc.) delegate tasks to Antigravity's agentic CLI — with model selection (Gemini, Claude, GPT-OSS), conversation resume, and workspace controls.

For the why behind it, read the [project write-up on trishchuk.com](https://trishchuk.com/projects/antigravity-mcp-server/). It covers how I use Claude Code or Cursor as the lead engineer and hand bounded work to Antigravity: long tasks delegated to the Gemini 4 Orchestrator in an isolated git worktree, read-only plans and reviews from a different model family, and large-context digests. It also has a table for choosing the right tool, the costs and isolation limits to know before delegating, and where Google's multi-agent tooling is heading.

## Requirements

- Node.js >= 18
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) installed (`agy --version` works) and authenticated (run `agy` once interactively and sign in with your Google account)

## Installation

```bash
npm install -g @trishchuk/antigravity-mcp-server
```

додай
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

| Tool                                 | Description                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-antigravity`                    | Run a prompt through `agy` in print mode. Supports model + `effort`, `mode`, session resume, `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`, dry-run.                     |
| `plan-antigravity`                   | Generate a structured implementation plan (JSON or markdown) without mutating anything.                                                                                               |
| `review-changes`                     | Collect a git diff (working tree / vs base branch / specific commit) and run a structured code review.                                                                                |
| `brainstorm`                         | Structured ideation (divergent, convergent, SCAMPER, design-thinking, lateral).                                                                                                       |
| `digest-antigravity`                 | Ingest many files/directories and answer a focused question using Antigravity's large model context. Credential files (`.env`, keys…) are withheld.                                   |
| `batch-antigravity`                  | Run multiple atomic tasks sequentially or in parallel (priority order, stop-on-error, concurrency cap).                                                                               |
| `bg-antigravity`                     | Detached background tasks: start / status / tail / stop / remove / list. State persists in `~/.agy-mcp/bg/` across server restarts.                                                   |
| `delegate-antigravity`               | Long multi-step tasks: runs detached in its own git worktree, on the Orchestrator model by default; live `status`, follow-up `continue` turns, `result` with the agent report + diff. |
| `list-sessions`                      | List / delete / clear conversation sessions.                                                                                                                                          |
| `list-models`                        | Available models (`agy models`) grouped by family, with the `effort` levels each accepts and what it is for.                                                                          |
| `health`                             | Diagnose CLI installation, authentication, models, and session state.                                                                                                                 |
| `ping`, `Help`, `version`, `metrics` | Utilities.                                                                                                                                                                            |

Background, batch and delegate tools default to `--dangerously-skip-permissions` because print mode cannot answer interactive permission prompts; pass `skipPermissions: false` to opt out. An explicit `mode` turns that default off (the mode is the permission policy), and `mode: "plan"` with `skipPermissions: true` is rejected.

## Models

The `model` parameter takes a **display label** (`Gemini 4 Hydrogen (High)`), a **full ID** (`gemini-4-hydrogen-high`), or a **base ID plus `effort`** (`model: "gemini-4-hydrogen", effort: "xhigh"`). A base _label_ with `effort` is rejected by the CLI. As of Antigravity CLI v1.5.9 (availability depends on your plan — `list-models` shows the live list):

| Family               | Base ID                          | `effort`                 | What it is for                                                                                                                                           |
| -------------------- | -------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini 4 Hydrogen    | `gemini-4-hydrogen`              | low, medium, high, xhigh | Fast everyday coding and maintenance (upgrades, boilerplate, tests, docs). The implementer inside Orchestrator.                                          |
| Gemini 4 Argon       | `gemini-4-argon`                 | low, medium, high        | Maximum reasoning depth on every step; planner of Orchestrator (Argon).                                                                                  |
| Gemini 4 Carbon      | `gemini-4-carbon`                | low, medium, high        | Maximum-depth reasoning (e.g. designing complex systems); planner of Orchestrator (Carbon). Ultra / Enterprise only.                                     |
| Orchestrator (Argon) | `gemini-pro-orchestrator-g1-pro` | — (fixed)                | Long tasks: the planner plans and reviews, Hydrogen implements, builds and tests, and hands back on repeated failures. One agent, no parallel subagents. |
| Gemini 3.8 Flash     | `gemini-3.8-flash`               | low, medium, high        |                                                                                                                                                          |
| Claude Opus 5.5      | `claude-opus-5-5`                | low, medium, high        |                                                                                                                                                          |
| Claude Sonnet 5.5    | `claude-sonnet-5-5`              | low, medium, high        |                                                                                                                                                          |
| GPT-OSS 120B         | `gpt-oss-120b`                   | medium                   | Scheduled for removal on 2026-11-18.                                                                                                                     |

`agy --effort` accepts `low | medium | high | xhigh | max`, but each model supports only the subset above (no current model accepts `max`); a suffixed ID such as `gemini-4-hydrogen-high` only accepts its own level. Orchestrator has a fixed thinking level and rejects `effort`.

Omit `model` and the server passes no `--model` flag, so the CLI's own default applies (`"model"` in `~/.gemini/antigravity-cli/settings.json`). The label this server uses in its examples and hints is `Gemini 4 Hydrogen (High)` — see `DEFAULT_MODEL` in `src/constants.ts`.

## Delegating long tasks

`delegate-antigravity` hands a multi-step implementation task to Antigravity and returns immediately:

```json
{
  "task": "Add rate limiting to the /api routes",
  "autoTest": "pnpm test",
  "acceptanceCriteria": ["429 after 100 req/min"]
}
```

- Creates a git worktree on a fresh `agy/<random>` branch under `~/.agy-mcp/delegations/` and runs `agy` detached there (survives the MCP call and server restarts).
- Without `model`, picks the **Orchestrator** (Carbon if your plan has it, else Argon); otherwise falls back to `Gemini 4 Hydrogen (High)`.
- Captures `--output-format stream-json`: `action: "status"` shows steps, tool calls, the last command and the latest text; `action: "continue"` with a `message` sends a follow-up turn into the same conversation and worktree; `action: "result"` returns the agent's final report, outcome (`finished_reason`), token usage and the diff against the base commit (`cleanup: true` removes the worktree and branch).
- Per-turn timeout defaults to 2 hours (`timeout: 0` = none). `stop` signals the whole process group (`signal`: `SIGTERM` by default, `SIGKILL` for a run that ignores it).

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

How it works: in text output `agy` doesn't print its conversation ID to stdout, so the server passes `--log-file` to a temp file and parses the ID from it (`Created conversation <uuid>` / `conversationID="<uuid>"`). The next call with the same `sessionId` resumes via `agy --conversation <uuid>`.

You can also pass a native `conversationId` directly, or `continueLatest: true` for `agy --continue`.

Session storage is in-memory (lost on server restart). Configure with:

- `AGY_SESSION_TTL_MS` — session TTL (default 24h)
- `AGY_MAX_SESSIONS` — max stored sessions (default 50)
- `AGY_MCP_CWD` — default working directory for `agy` runs. Resolution order: `workingDir` → `AGY_MCP_CWD` → the project root of an `@path` in your prompt (`ask`, `digest`, `delegate`) → the server's launch directory

## Safety

- `skipPermissions: true` maps to `--dangerously-skip-permissions` — agy auto-approves all tool/command permission requests. Use deliberately.
- `sandbox: true` maps to `--sandbox` — terminal restrictions enabled.
- Since CLI 1.5.7 headless runs start in **Auto** mode where it is available, which edits files without asking. `plan-antigravity`, `review-changes`, `digest-antigravity` and `brainstorm` therefore pass `--settings '{"agentMode":"","permissions":{"allow":[]}}'`: Default mode, plus your allow-rules suspended for that run (otherwise a pre-approved command such as `git checkout` still executes). A headless run cannot answer permission prompts, so writes and shell commands are auto-denied; reading files works and the answer still reaches stdout. (`--mode plan` is not used because it writes the answer into a plan artifact instead.)
- `mode` maps to `--mode accept-edits | auto | plan`; Auto is not available on every account.
- A delegation worktree isolates git state, not the filesystem: with `skipPermissions` (the default for background work) the agent can read and write outside it and run any command.
- `digest-antigravity` never sends credential-like files (`.env*`, `.npmrc`, private keys, `*.pem`, …) and does not follow symlinks while walking directories.
- Cancelling a tool call from the client stops the `agy` / `git` processes it started; background and delegated tasks keep running until you `stop` them.
- An explicit `workingDir` / `cd` that does not exist is an error — the server never falls back to another directory.
- Otherwise agy uses your configured permission rules (`/permissions` in interactive agy).

## Development

```bash
pnpm build          # tsc
pnpm lint           # tsc --noEmit
pnpm test           # build + node --test
pnpm format         # prettier
```

## License

MIT
