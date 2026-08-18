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

## Architecture

- `src/index.ts` — MCP server entry (stdio transport). Handles tools, prompts, completions, logging, and keepalive progress notifications (25s interval) for long agy runs.
- `src/tools/registry.ts` — `UnifiedTool` interface + registry; tools are zod-schema'd, converted to JSON Schema via `zod-to-json-schema`.
- `src/tools/*.tool.ts` — individual tools; registered in `src/tools/index.ts`.
- `src/utils/agyCommandBuilder.ts` — builds argv for `agy`. Always appends `--log-file <tmp>` (see below) and `-p <prompt>` last. Prompts >100KB go via stdin (bare `-p`).
- `src/utils/agyExecutor.ts` — spawns agy, classifies errors, parses the conversation ID.
- `src/utils/sessionStorage.ts` — in-memory sessions keyed by workspace hash; maps internal `sessionId` → native agy conversation UUID. `withSessionLock` serializes concurrent calls sharing a sessionId.
- `src/utils/bgTaskManager.ts` — detached background agy processes. State in `~/.agy-mcp/bg/`: `<id>.json` (meta), `<id>.log` (merged stdout/stderr), `<id>.agylog` (agy's own `--log-file`, conversation-ID source). Bg tasks default to `--dangerously-skip-permissions`.
- `delegate-antigravity` builds on bgTaskManager: git worktree under `~/.agy-mcp/delegations/`, branch `agy/<rand>`, collect returns the diff vs base.

## Key agy CLI facts (v1.1.14)

- Print mode: `agy -p "<prompt>"`, or bare `-p` with prompt on stdin. `--print-timeout` takes a Go duration (`600s`).
- Model: `--model` accepts **either** column of `agy models` — the ID (`gemini-3.7-flash-high`) or the display label (`Gemini 3.7 Flash (High)`). Auth required to list.
- Stream routing differs per subcommand: `agy models` puts the `<id>\t<label>` rows on **stdout** and its "Fetching available models..." line on stderr (on a TTY it echoes rows to both); **`agy --help` writes entirely to stderr** (exit code 0), so `executeCommand` (stdout-only) returns an empty string for it. Read both streams — see `src/utils/modelList.ts`.
- Resume: `--conversation <uuid>` or `--continue`. **The conversation ID is not printed to stdout** — it's recovered from the CLI log (`--log-file`). Log formats seen: `Created conversation <uuid>` (new runs) and `Print mode: starting (..., conversationID="<uuid>")` (resumed runs — no "Created" line). The old 1.0.x `Print mode: conversation=<uuid>` form is gone; `parseConversationIdFromLog` matches all three.
- 1.0.x replayed the previous assistant message on resume; 1.1.14 no longer does. The prefix-stripping in `ask-agy.tool.ts` is now a harmless no-op.
- Flags added since 1.0.7, **not yet wired into any tool**: `--effort` (low|medium|high), `--output-format` (text|json|stream-json), `--input-format`, `--json-schema`, `--agent`, `--mode` (accept-edits|plan), `--project` / `--new-project`, `--disable-slash-commands`, `-c`/`-i` aliases. New subcommands: `agents`, `install`. Constants for these live in `CLI.FLAGS` for reference only.
- Config lives under `~/.gemini/antigravity-cli/`; `"model"` there is the CLI's own default, used whenever a tool omits `--model`.

## Conventions

- ESM (`"type": "module"`), Node16 module resolution — all relative imports need `.js` extension.
- Tool names use the `ask-antigravity` / `plan-antigravity` style; internal files use the `agy` shorthand.
