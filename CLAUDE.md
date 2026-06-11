# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that bridges MCP clients to the Google Antigravity CLI (`agy`). Ported from `kimi-mcp-server` (same architecture, adapted to agy's much smaller flag surface). All agy execution goes through print mode (`-p`).

## Commands

```bash
npm run build       # tsc → dist/
npm run lint        # tsc --noEmit
npm test            # build + node --test on dist/**/*.test.js
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

## Key agy CLI facts (v1.0.7)

- Print mode: `agy -p "<prompt>"`, or bare `-p` with prompt on stdin. `--print-timeout` takes a Go duration (`600s`).
- Model: `--model "<display label>"` from `agy models` (labels, not IDs; auth required to list).
- Resume: `--conversation <uuid>` or `--continue`. **The conversation ID is not printed to stdout** — it's recovered from the CLI log (`--log-file` → parse `Print mode: conversation=<uuid>`).
- On resume, print mode replays the previous assistant message before the new one; `ask-agy.tool.ts` strips the known prefix.
- No flags for: thinking, output format, config injection, agent specs. Available: `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`, `--log-file`.
- Config lives under `~/.gemini/antigravity-cli/`.

## Conventions

- ESM (`"type": "module"`), Node16 module resolution — all relative imports need `.js` extension.
- Tool names use the `ask-antigravity` / `plan-antigravity` style; internal files use the `agy` shorthand.
