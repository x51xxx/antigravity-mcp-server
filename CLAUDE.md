# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that bridges MCP clients to the Google Antigravity CLI (`agy`). Ported from `kimi-mcp-server` (same architecture, adapted to agy's much smaller flag surface). All agy execution goes through print mode (`-p`).

## Commands

```bash
pnpm build          # tsc → dist/
pnpm lint           # tsc --noEmit
pnpm test           # build + node --test on dist/**/*.test.js
```

Release: bump `version` in `package.json` **and** both `version` fields in `server.json` (MCP Registry), `npm publish`, then `mcp-publisher validate && mcp-publisher publish` (the registry checks `mcpName` in the published npm package, so npm goes first).

## Architecture

- `src/index.ts` — MCP server entry (stdio transport). Handles tools, prompts, completions, logging, and keepalive progress notifications (25s interval) for long agy runs.
- `src/tools/registry.ts` — `UnifiedTool` interface + registry; tools are zod-schema'd, converted to JSON Schema via `zod-to-json-schema`.
- `src/tools/*.tool.ts` — individual tools; registered in `src/tools/index.ts`.
- `src/utils/agyCommandBuilder.ts` — builds argv for `agy`. Always appends `--log-file <tmp>` (see below) and `-p <prompt>` last. Prompts >100KB go via stdin as one `--input-format stream-json` user event (no `-p`), which forces stream-json stdout (`BuildResult.streamJsonOutput`); `executeAgyCLI` unwraps it, bg tasks store it in `<id>.out`.
- `src/utils/agyExecutor.ts` — spawns agy, classifies errors, parses the conversation ID.
- `src/utils/sessionStorage.ts` — in-memory sessions keyed by workspace hash; maps internal `sessionId` → native agy conversation UUID. `withSessionLock` serializes concurrent calls sharing a sessionId.
- `src/utils/bgTaskManager.ts` — detached background agy processes. State in `~/.agy-mcp/bg/`: `<id>.json` (meta), `<id>.log` (stderr; text tasks: merged stdout/stderr), `<id>.out` (stream-json stdout of structured tasks), `<id>.agylog` (agy's own `--log-file`, conversation-ID source). Bg/batch/delegate default to `--dangerously-skip-permissions` unless a `mode` is given (`defaultSkipPermissions`); `mode: plan` + skipPermissions is rejected by the builder. On Windows agy is started via `src/utils/bgLauncher.ts` (spawned detached, runs agy non-detached with `windowsHide`): a detached agy has no console, so each tool command opens a visible window, while a non-detached child of the server sits in Node's kill-on-close job object and dies with the server. `stopBgTask` uses `taskkill /T` there.
- `delegate-antigravity` (long tasks) builds on bgTaskManager: git worktree under `~/.agy-mcp/delegations/`, branch `agy/<rand>`, Orchestrator model by default (`pickOrchestrator`), stream-json output; actions start/status/continue/result/stop/list; diffs against the resolved base SHA.

## Key agy CLI facts (v1.5.9)

- Print mode: `agy -p "<prompt>"`. A bare `-p` no longer reads stdin (`flag needs an argument: -p`); the only stdin channel is `--input-format stream-json` + `--output-format stream-json`, one line per turn: `{"event":"user","message":{"content":"…"}}` (a `-p` prompt is ignored in that mode). There a print timeout exits **0**; check the `result` event (`finished_reason: "print_timeout"`). `--print-timeout` takes a Go duration (`600s`); default is now `0s` (no limit — headless runs also wait for their background tasks). A print timeout exits with code 3.
- Model: `--model` accepts the ID (`gemini-4-hydrogen-high`), the display label (`Gemini 4 Hydrogen (High)`), or a base ID (`gemini-4-hydrogen`) plus `--effort`. A base _label_ plus `--effort` is rejected. Effort subsets per model are in `MODEL_FAMILIES` (src/constants.ts); Orchestrator (`gemini-pro-orchestrator-g1-pro`) rejects `--effort`. Bad model/effort → exit 1, `error: invalid model selection (...)` on stderr.
- **Since 1.5.7 headless runs default to Auto mode** (edits files without asking) where available. Read-only tools pass `--settings '{"agentMode":"","permissions":{"allow":[]}}'` (`READ_ONLY_SETTINGS`) → Default mode with the user's allow-rules suspended (without that, an allowed `git checkout` ran and reverted a dirty file); writes and shell commands auto-denied, file reads work, answer on stdout. `--mode plan` is unsuitable: the answer goes into a plan artifact. `--mode auto` is unavailable on some accounts (falls back to Default with a warning). `--settings` overlays settings.json (default model kept).
- Model/agent failures: exit code 3 and an `AGY_ERROR: {...}` JSON line on stderr (`parseAgyErrorLine`). A denied permission is NOT an error: exit 0, empty stdout, explanation on stderr (`emptyResponseNote`).
- Output: `--output-format json` → one object (`conversation_id`, `status`, `response`, `usage`, `error`, `finished_reason`); `stream-json` → `init` (has `conversation_id` immediately), `step_update` events (tool calls, `text_delta`), final `result`. Parsed by `src/utils/streamJson.ts`; used by `delegate-antigravity` background turns (stdout → `<id>.out`).
- Text-output runs still recover the conversation ID from the CLI log (`--log-file`): `Created conversation <uuid>` (new), `conversationID="<uuid>"` / `Print mode: conversation=<uuid>` (resumed). Resume no longer replays the previous answer.
- `stream-json` stdout and stderr must go to separate files — don't merge them.
- Flags not yet wired into tools: `--json-schema`, `--input-format`, `--agent`, `--project` / `--new-project`, `--remote-agent`, `--remote-control`, `--disable-slash-commands`. Subcommands: `acp` (ACP server), `agents`, `mcp`, `plugin`, `remote-control`, `changelog`, `update`, `install`.
- Config lives under `~/.gemini/antigravity-cli/`; `"model"` there is the CLI's own default, used whenever a tool omits `--model`.

## Conventions

- Expected failures return `toolError("❌ …")` (registry.ts) so the client gets `isError: true`; never return a bare "❌" string.
- Foreground spawns go through `executeCommandDetailed`, which picks up the MCP request's abort signal via `runWithAbortSignal` (AsyncLocalStorage, set in index.ts) — a cancelled call kills the child. On POSIX each foreground child runs in its own process group, so timeout/cancel signal the whole tree, and the call resolves 2 s after the child exits even if a leftover process keeps the pipes open. Detached bg tasks are intentionally not tied to it.
- `@path` working-directory resolution only ever sees the user's own text (ask prompt, digest question, delegate task) — `agyCommandBuilder` never resolves from the composed prompt.
- ESM (`"type": "module"`), Node16 module resolution — all relative imports need `.js` extension.
- Tool names use the `ask-antigravity` / `plan-antigravity` style; internal files use the `agy` shorthand.
