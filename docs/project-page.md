# Antigravity MCP Server

An MCP server connecting Claude Code, Cursor, and other AI assistants to Google Antigravity CLI · npm package `@trishchuk/antigravity-mcp-server` · sibling of [Codex MCP Server](/projects/codex-mcp-tool/)

[npm ↗](https://www.npmjs.com/package/@trishchuk/antigravity-mcp-server) · [GitHub ↗](https://github.com/x51xxx/antigravity-mcp-server) · [Changelog ↗](https://github.com/x51xxx/antigravity-mcp-server/blob/main/CHANGELOG.md)

**Contents**

- [Why Hand Work to Antigravity](#why-hand-work-to-antigravity)
- [Features](#features)
- [Quick Start](#quick-start)
- [Usage Examples](#usage-examples)
- [Tools](#tools)
- [Models](#models)
- [Key Features](#key-features)
- [Advanced Options](#advanced-options)
- [CLI Compatibility](#cli-compatibility)
- [Where This Is Heading](#where-this-is-heading)
- [Troubleshooting](#troubleshooting)

MCP server connecting Claude/Cursor to [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`), Google's terminal agent. It runs `agy` headless and turns it into MCP tools: one-shot questions, read-only plans and reviews, large-context codebase digests, batches, background jobs, and long tasks delegated to an isolated git worktree.

## Why Hand Work to Antigravity

Your main assistant does not have to do all the work itself. A better split is for Claude Code (or Cursor) to act as the **lead engineer**: it keeps the conversation, the architecture and the final say, and hands well-scoped work to another agent.

Three ways to use the server this way:

- **Delegate the long grind.** Give `delegate-antigravity` a task, acceptance criteria and a test command. Antigravity works on its own branch in a separate git worktree, by default on the **Orchestrator** model when your plan includes it. A Gemini 4 planner explores and plans, Gemini 4 Hydrogen edits, builds and tests, and control goes back to the planner when verification runs into trouble. While that runs, your lead agent keeps reviewing, polls `status`, sends corrections with `continue`, and pulls back a diff it can apply selectively.
- **Get a second opinion from a different vendor.** A plan or code review from a different model family catches different mistakes. `plan-antigravity` and `review-changes` run in a read-only setup: the agent can read your files, but writes and shell commands are denied.
- **Fit the whole codebase into one prompt.** `digest-antigravity` packs dozens of files into a single prompt and answers one focused question. Use it when your lead agent's own context is already busy with the task at hand. Credential files (`.env*`, `.npmrc`, private keys) are withheld and symlinks are not followed, because the payload leaves your machine.

## Features

- Long-Task Delegation — isolated git worktree, fresh branch, Orchestrator by default, follow-up turns, diff on completion
- Live Progress — structured `stream-json` output, so `status` shows steps, tool calls and the agent's latest text
- Read-Only Analysis — plans, reviews, digests and brainstorms run in the CLI's Default agent mode, where file writes are denied rather than auto-approved
- Native Resume — multi-turn sessions mapped to Antigravity's own conversation IDs
- Model & Effort Control — any `agy models` ID or label, plus per-model `--effort` (`low` … `xhigh`)
- Large-Context Digest — feed many files into one prompt and ask a focused question; credential files are never sent
- Cancellation — cancelling a tool call in the client stops the `agy` process it started
- Batch & Background — parallel atomic tasks with a concurrency cap; detached jobs persisted on disk
- Model Discovery — `list-models` groups models by family, with accepted effort levels and intended use
- Health Diagnostics — CLI install, authentication, models and session state

## Quick Start

```bash
claude mcp add antigravity -- npx -y @trishchuk/antigravity-mcp-server
```

Prerequisites: Node.js 18+, [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) installed (`agy --version`) and signed in (run `agy` once interactively).

### Configuration

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

Config locations: macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` | Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Usage Examples

```js
// Delegate a long task (Orchestrator, isolated worktree)
'delegate to antigravity: migrate the payments module to the new SDK,
 acceptanceCriteria: ["no public API changes"], autoTest: "pnpm test"'
'check status of the antigravity delegation'
'tell the delegation: the webhook tests still fail, fix the signature check'
'get the delegation result and show me the diff'

// Second opinion from another vendor
'review my uncommitted changes with antigravity'
'plan-antigravity goal:"add rate limiting to the public API" format:"markdown"'

// Large-context question
'digest-antigravity question:"where is auth state mutated?" paths:["src/", "lib/"]'

// Specific model and effort
'ask antigravity model:"gemini-4-hydrogen" effort:"xhigh" prompt:"explain src/scheduler.ts"'

// Multi-turn conversation
'ask antigravity sessionId:"auth" prompt:"analyze src/auth.ts for security issues"'
'ask antigravity sessionId:"auth" prompt:"now suggest fixes"'
```

## Tools

| Tool | Description |
| --- | --- |
| `delegate-antigravity` | Long multi-step task in an isolated worktree: `start`, `status`, `continue`, `result`, `stop`, `list` |
| `ask-antigravity` | Run a prompt with model, effort, mode, workspace dirs and session resume |
| `plan-antigravity` | Structured implementation plan (JSON or markdown), read-only |
| `review-changes` | Review the working tree, a branch diff or a commit, read-only |
| `digest-antigravity` | Ingest many files and answer one focused question, read-only |
| `brainstorm` | Ideation with SCAMPER, design-thinking, lateral and other frameworks |
| `batch-antigravity` | Many atomic tasks, sequential or parallel, with priority and a concurrency cap |
| `bg-antigravity` | Detached background tasks: start / status / tail / stop / remove / list |
| `list-models` | Models grouped by family, with accepted effort levels and intended use |
| `list-sessions` | View, delete or clear conversation sessions |
| `health` | Diagnose CLI installation, authentication, models and sessions |
| `ping`, `Help`, `version`, `metrics` | Utilities |

## Models

By default the `model` parameter is omitted and the CLI uses its own default (`"model"` in `~/.gemini/antigravity-cli/settings.json`). The exception is `delegate-antigravity`. It picks Orchestrator (Carbon), then Orchestrator (Argon), whichever your account has, and falls back to Gemini 4 Hydrogen (High). `model` accepts either column of `agy models`, the ID or the display label. You can also pass a base ID such as `gemini-4-hydrogen` together with `effort`.

| Model | Effort | Recommendation |
| --- | --- | --- |
| Orchestrator (Carbon / Argon) | fixed | Long multi-step tasks: planner + Hydrogen implementer in one conversation |
| `gemini-4-hydrogen` | low – xhigh | Fast everyday coding and maintenance: upgrades, boilerplate, tests, docs |
| `gemini-4-argon` | low – high | Deep reasoning on hard problems; the planner in Orchestrator (Argon) |
| `gemini-4-carbon` | low – high | Maximum-depth reasoning, e.g. designing complex systems from scratch (Ultra / Enterprise) |
| `gemini-3.8-flash` | low – high | Previous-generation Flash model, on all plans |
| `claude-opus-5-5`, `claude-sonnet-5-5` | low – high | Anthropic models served through Antigravity |

Which models you get depends on your plan. Per Google, Orchestrator (Argon) needs a paid Google AI Pro or Ultra plan, Orchestrator (Carbon) needs Ultra, and Gemini 4 Carbon needs Ultra or Enterprise. Run `list-models` to see what your account offers. Orchestrator has a fixed thinking level, so the server rejects `effort` for it.

## Key Features

### Delegation Lifecycle

`start` creates a worktree under `~/.agy-mcp/delegations/` on a new branch `agy/<random>` and launches a detached `agy` run. The run is told to plan, implement, verify after every step (looping on `autoTest` if you give one) and finish with a report. It is told not to commit.

```json
{ "action": "start", "task": "Add CSV export to the reports page",
  "acceptanceCriteria": ["streams large files", "covered by tests"], "autoTest": "pnpm test" }
{ "action": "status", "taskId": "…" }
{ "action": "continue", "taskId": "…", "message": "Keep the existing column order" }
{ "action": "result", "taskId": "…", "cleanup": true }
```

`result` returns the agent's final report, the run's outcome, its token usage, a diffstat, untracked files and the full diff against the base commit. Delegations run detached, so they survive the MCP call and server restarts. Each turn defaults to a 2-hour limit.

### Sessions & Resume

The server tracks sessions per workspace and maps each internal `sessionId` to Antigravity's native conversation ID. The CLI does not print that ID in text mode. The server recovers it from the CLI's own log file, or from the `stream-json` events, and resumes with `--conversation`. Concurrent calls that share a session are serialized.

```json
{ "prompt": "analyze code", "sessionId": "my-session" }
{ "prompt": "continue from here", "sessionId": "my-session" }
{ "prompt": "start fresh", "sessionId": "my-session", "resetSession": true }
```

Environment:

- `AGY_MCP_CWD` — default working directory for `agy` runs (an explicit `workingDir` wins; a `workingDir` that does not exist is an error, never a silent fallback)
- `AGY_SESSION_TTL_MS` — session TTL (default: 24h)
- `AGY_MAX_SESSIONS` — max sessions (default: 50)

### Read-Only Tools

Since CLI 1.5.7, headless runs start in Auto mode where it is available, and Auto mode edits files without asking. `plan-antigravity`, `review-changes`, `digest-antigravity` and `brainstorm` override this with a session-only `--settings` overlay that selects the Default agent mode. The overlay also empties `permissions.allow` for that run, because a pre-approved command such as `git checkout` would otherwise still execute. A headless run in Default mode cannot answer a permission prompt, so writes and shell commands are denied while reading files still works and the answer comes back on stdout. These tools also refuse `--dangerously-skip-permissions`. Review diffs are treated as untrusted input for the same reason.

## Advanced Options

| Parameter | Description |
| --- | --- |
| `model` | Model ID or label from `agy models` |
| `effort` | `low`, `medium`, `high`, `xhigh` (subset per model; not for Orchestrator) |
| `mode` | `accept-edits`, `auto` (not on every account), `plan` |
| `sessionId` | Conversation continuity, isolated per workspace |
| `conversationId` | Resume a native Antigravity conversation directly |
| `continueLatest` | Resume the most recent conversation (`--continue`) |
| `addDirs` | Additional workspace directories |
| `sandbox` | Run terminal commands in the OS sandbox |
| `skipPermissions` | Auto-approve all tool calls (default for batch, background and delegate) |
| `acceptanceCriteria` | Delegate: criteria the implementation must meet |
| `autoTest` | Delegate: command the agent must loop on until it passes |
| `baseBranch` / `branchName` | Delegate: worktree base and branch name |
| `cleanup` | Delegate: remove the worktree and branch after collecting the result |
| `timeout` | Per-call / per-turn time limit in milliseconds |

## CLI Compatibility

Validated against Antigravity CLI `1.5.9`. Notable current behavior:

- Headless runs default to Auto mode since 1.5.7 (per `agy changelog`). Read-only tools pin Default mode explicitly.
- `--effort` levels vary by model, and Orchestrator rejects the flag. `list-models` shows what each family accepts.
- `--output-format stream-json` drives delegation progress. The final `result` event carries `conversation_id`, `status`, `response` and `usage`.
- Auto mode needs the terminal sandbox and is not offered on business or enterprise accounts.
- GPT-OSS 120B, Claude Sonnet 4.6 and Claude Opus 4.6 are scheduled for removal from Antigravity on 2026-11-18.

## Where This Is Heading

Google's Gemini 4 line-up shows how it now thinks about coding agents: one big model no longer does everything, and each model has a role.

**Planner and implementer are separate models.** Orchestrator puts that split into the model picker. Argon or Carbon runs a read-only planning phase, Hydrogen implements and verifies, and control goes back to the planner when Hydrogen hits friction (for example, a verification step failing twice). Google's own figures for Terminal-Bench 4.1: near-Carbon success rates while using 24% less quota and finishing 19% faster. The pattern matters more than the number, and it repeats one level up: Claude Code plans and reviews, and an Orchestrator plans and executes beneath it.

**One agent is turning into a team.** `/swarm` (in preview) makes the agent a coordinator. It starts parallel workers in isolated git worktrees, and verifiers run the tests and challenge the diffs, all on a shared append-only message board. CLI 1.5.9 added `run_workflow`, which runs a Python script that fans work out to many subagents. The server does not drive either yet. Its parallelism is `batch-antigravity` on the MCP side.

**Headless output is now something other programs can read.** JSON and stream-json output, with conversation IDs, status and token usage, turned delegation from "spawn a process and grep stdout" into a process you can observe and resume. `--json-schema` enforces a schema on the final answer. The server does not use it yet, and it is the obvious next step for plans and reviews that other agents consume.

**Protocols matter more than which tool you use.** `agy acp` serves the agent over the Agent Client Protocol to editors such as Zed and JetBrains IDEs. `agy mcp` lets it use MCP servers, and this server exposes it as MCP tools. `--remote-agent` already runs conversations on remote agents, so delegated work may soon leave the laptop.

**Caveats.** The worktree isolates git state, not the filesystem. With `skipPermissions` on (the default for delegation), the agent can run any command and touch files outside the worktree. `sandbox` restricts terminal commands, but it is not full isolation. The worktree starts from the base commit, so uncommitted changes in your checkout are not part of it. Heavy modes cost more. Orchestrator (Carbon) is Ultra-only, and Google warns that parallel multi-agent runs use quota much faster than a normal chat. Google does say Orchestrator uses fewer tokens than running the planner alone.

## Troubleshooting

```bash
agy --version    # Check CLI version
agy              # Sign in interactively once
agy models       # Confirm auth and see available models
```

Use the `health` tool for diagnostics: `'use health verbose:true'`

## Further Reading

- [@trishchuk/antigravity-mcp-server on npm](https://www.npmjs.com/package/@trishchuk/antigravity-mcp-server)
- [Source on GitHub](https://github.com/x51xxx/antigravity-mcp-server)
- [Antigravity CLI docs](https://antigravity.google/docs/cli-getting-started)
- [Antigravity models](https://antigravity.google/docs/models)
- [Gemini 4 Hydrogen and Orchestrator](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity)
- [Model Context Protocol](https://modelcontextprotocol.io)
- Siblings: [codex-mcp-tool](https://github.com/x51xxx/codex-mcp-tool) · [kimi-mcp-server](https://github.com/x51xxx/kimi-mcp-server)

<!--
Sources used:
- https://trishchuk.com/projects/codex-mcp-tool/ (structure and tone template)
- https://antigravity.google/docs/models
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/acp
- https://antigravity.google/blog
- https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity
- https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity
- https://antigravity.google/blog/gemini-4-argon-in-google-antigravity
- https://antigravity.google/blog/introducing-google-antigravity-cli
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/
- Local: `agy --help`, `agy models`, `agy changelog` (Antigravity CLI 1.5.9)
- Repo: README.md, CHANGELOG.md, src/ (tool schemas, constants, delegate-agy.tool.ts)
-->
