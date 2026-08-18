# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-18

Support for Antigravity CLI **v1.1.14** (previously targeted v1.0.7).

### Added

- Gemini 3.7 Flash and Gemini 3.6 Flash (Low / Medium / High) to the known model
  list. `list-models` and the `model` argument completions pick these up
  automatically.
- `--model` now documented as accepting **either** column of `agy models` — the
  model ID (`gemini-3.7-flash-high`) or the display label
  (`Gemini 3.7 Flash (High)`). Both are verified to work.
- `list-models` returns model IDs alongside labels in `structuredContent`
  (new `modelIds` field; the existing `models` field is unchanged).
- `src/utils/modelList.ts` — shared parser for `agy models` output, tolerant of
  both the v1.0.x (label-only) and v1.1.x (`<id>\t<label>`) formats.
- First unit tests (`src/utils/modelList.test.ts`), run by `pnpm test`.

### Fixed

- **`list-models` returned unusable model labels.** `agy models` changed its
  output to tab-separated `<id>\t<label>` rows, and the old parser emitted the
  whole raw row as a single label, which could not be passed back as `model`.
- **The `Help` tool returned an empty string.** `agy --help` writes to stderr,
  but the tool read stdout only. It now merges both streams.
- **Conversation ID was not recovered from resumed runs.** v1.1.x logs
  `Print mode: starting (..., conversationID="<uuid>")` instead of the v1.0.x
  `Print mode: conversation=<uuid>`, and emits no `Created conversation` line
  when resuming. `parseConversationIdFromLog` now matches all known formats,
  which also covers background tasks via `bgTaskManager`.
- `health` now reports parsed model labels instead of raw tab-joined rows.

### Changed

- Server version is read from `package.json` at runtime (`src/version.ts`)
  rather than hardcoded in `src/index.ts` and the `version` tool.
- New `DEFAULT_MODEL` constant (`Gemini 3.7 Flash (High)`) drives the model
  hints in error output. This is a **documentation** default only — omitting the
  `model` argument still passes no `--model` flag, so the CLI's own default
  applies (`"model"` in `~/.gemini/antigravity-cli/settings.json`).
- Example model labels across README, error hints and doc comments moved from
  `Gemini 3.5 Flash` to `Gemini 3.7 Flash`.
- `CLI.FLAGS` documents flags added in CLI 1.1.x — `--effort`,
  `--output-format`, `--input-format`, `--json-schema`, `--agent`, `--mode`,
  `--project` / `--new-project`, `--disable-slash-commands` — for reference.
  **No tool wires these up yet.**
- `prepublishOnly` now runs `format:check`, `lint` and `test` instead of
  printing a reminder.
- Compiled test files are excluded from the published package.

### Notes

- CLI v1.1.14 no longer replays the previous assistant message when resuming a
  conversation, so the prefix-stripping in `ask-antigravity` is now a no-op. It
  is retained for compatibility with older CLI builds.

## [0.1.0] - 2026-06-12

### Added

- Initial release: MCP server bridging MCP clients to the Google Antigravity
  CLI (`agy`), targeting CLI v1.0.7.
- Tools: `ask-antigravity`, `plan-antigravity`, `review-changes`,
  `brainstorm`, `digest-antigravity`, `batch-antigravity`, `bg-antigravity`,
  `delegate-antigravity`, `list-sessions`, `list-models`, `health`, `ping`,
  `Help`, `version`, `metrics`.
- Session management with native conversation resume, detached background
  tasks, and git-worktree delegation.

<!-- 0.1.0 was published from 357898e; no v0.1.0 tag was created, so it is
     linked by commit. The 0.2.0 link resolves once the v0.2.0 tag is pushed. -->

[0.2.0]: https://github.com/x51xxx/antigravity-mcp-server/compare/357898ea2c0709fde911a2950e5adfb204011417...v0.2.0
[0.1.0]: https://github.com/x51xxx/antigravity-mcp-server/commit/357898ea2c0709fde911a2950e5adfb204011417
