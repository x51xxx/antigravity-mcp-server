# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Visible console windows on Windows** (reported in #1). Background tasks
  (`bg-antigravity`, `delegate-antigravity`) opened a new console window for
  every tool command agy ran. On Windows they now start through a small launcher
  (`dist/utils/bgLauncher.js`): the launcher is detached, so the task still
  survives an MCP server restart, and it runs agy with `windowsHide`, so agy's
  tool commands share one hidden console. Foreground runs also pass
  `windowsHide`. `stop` on Windows ends the whole process tree (`taskkill /T`)
  instead of agy alone. Other platforms are unchanged.

## [0.3.0] - 2026-11-14

Support for Antigravity CLI **v1.5.9**.

### Added

- MCP catalog metadata: `server.json` for the official MCP Registry
  (`io.github.x51xxx/antigravity-mcp-server`, matching `mcpName`), `glama.json`
  for Glama, richer npm description and keywords, and the project page as
  `homepage`.
- Gemini 4 Hydrogen, Argon and Carbon, Orchestrator (Argon / Carbon), Gemini 3.8
  Flash, Claude Opus 5.5 and Sonnet 5.5 in the known model list; `DEFAULT_MODEL`
  is now `Gemini 4 Hydrogen (High)`. Removed retired models (Gemini 3.x Pro /
  3.5–3.7 Flash, Claude 4.6).
- `effort` parameter (`--effort`) on ask, batch, bg, delegate, plan, review,
  digest and brainstorm, validated client-side (Orchestrator rejects it).
- `mode` parameter (`--mode accept-edits | auto | plan`) on ask, batch, bg and
  delegate.
- `list-models` groups models by family with the effort levels each accepts and
  its intended use (new `families` field in `structuredContent`).
- `delegate-antigravity` is now built for long tasks: Orchestrator by default,
  stream-json progress in `status`, `continue` for follow-up turns in the same
  conversation, `result` with the agent's report, outcome and token usage,
  `stop` and `list` actions, 2 h default per-turn timeout.

### Fixed

- **Read-only tools could edit files.** Since CLI 1.5.7 headless runs default to
  Auto mode; plan, review, digest and brainstorm now pass a session-only
  `--settings` overlay that forces Default mode and suspends the user's
  `permissions.allow` rules, so writes and shell commands are auto-denied
  (file reads still work).
- **Git option injection in `review-changes`:** a `commit` such as
  `--output=<file>` made git write an arbitrary file. Revisions starting with
  `-` are rejected and `--end-of-options` is passed.
- **Path traversal via `taskId`** in background-task actions; task IDs are now
  validated.
- **Server crashes:** a missing `agy` binary in background spawns, and EPIPE on
  stdin for long prompts, raised uncaught errors.
- **Debug/info logging went to stdout**, corrupting the MCP stdio stream.
- **Error classification:** any stderr containing "not found", "login" or
  "denied" was misreported (e.g. a model "not found" became "CLI not found");
  timeouts are now decided by our own timer, `AGY_ERROR` and model-selection
  errors are surfaced verbatim.
- Background tasks whose process vanished were always marked `completed`; the
  state now comes from the stream-json result, or `unknown`.
- `stop` could signal an unrelated process that reused a finished task's PID,
  and did not stop agy's child processes; it now requires a running task and
  signals the process group.
- Delegation diffs used the base _branch name_, which moves; they now use the
  resolved base commit. A failed start no longer leaves an orphaned worktree.
- Empty responses (e.g. a denied write in read-only mode) now show agy's
  explanation instead of a blank.
- **Prompts over 100 KB failed on agy 1.5.x.** They were piped to a bare
  `-p`, which the CLI now rejects (`flag needs an argument: -p`), so large
  digests and big-diff reviews broke. Long prompts now go in on stdin as one
  `--input-format stream-json` user event; the stream-json reply is unwrapped
  to the plain answer (bg tasks keep it in `<id>.out`, shown by `tail`), and a
  print timeout — which exits 0 in this mode — is still reported as an error.
- **`digest-antigravity` sent credential files to the model** — `.env*`,
  `.npmrc`, private keys and similar are now withheld (listed in the banner and
  `secretsSkipped`), and symlinks below the given roots are no longer followed.
- **Cancelled MCP requests left `agy` running.** The request's abort signal now
  stops every foreground process spawned for that call (detached background
  tasks are unaffected).
- **Tool failures were reported as successes:** "❌ …" results now carry
  `isError: true`, which also stops tools with an `outputSchema` from returning
  unstructured success results.
- **An invalid `workingDir` silently fell back to another directory**; it is
  now an error.
- Full prompts were logged at warn level; command lines are now logged at
  debug level only, with long arguments truncated.
- Removed the resume prefix-stripping in `ask-antigravity` (agy no longer
  replays the previous answer, and the strip could cut the start of a real
  answer).
- A `sessionId` reused in another workspace resumed that workspace's
  conversation; it now starts a fresh conversation for the new workspace
  (`ask-antigravity` also read the old conversation ID before that check).
- **`digest-antigravity` could read anything on disk:** `paths` are now confined
  to `workingDir` by their real path (skipped ones are listed in the banner and
  `outsideSkipped`); extensionless files no longer pass as text; files under
  `.ssh`, `.aws`, `.kube`, `.docker`, `.gnupg`, `.azure`, `.config/gcloud`, plus
  `.envrc` and `*.tfstate.backup` / `*.tfvars.json`, are withheld; and only the
  first `maxBytesPerFile` bytes of a file are read, instead of the whole file.
- The final progress notification said "completed successfully" for tool
  failures (`isError: true`), and a numeric `progressToken` of `0` got no
  progress notifications.
- **Foreground calls could hang forever:** a process that `agy` (or git) left
  behind kept the output pipes open, so the call never returned, and a
  timeout/cancel only signalled the direct child. Foreground children now run in
  their own process group (POSIX), which timeouts, cancels and server exit stop
  as a whole; the call returns 2 s after the child exits even if the pipes stay
  open; the SIGKILL escalation timer is cleared. A missing `cwd` is reported as
  such instead of "Command 'git' not found".
- **`delegate-antigravity` `result cleanup=true` forgot delegations it failed to
  clean up:** the record and task files were deleted even when `git worktree
remove` / `git branch -D` failed, leaving an orphaned worktree and branch. They
  are now kept until both are gone, so a retry can finish. `status` and `result`
  handle a worktree deleted by hand (report it; cleanup still deletes the
  branch) instead of failing with a misleading git error.
- **Error classification** checked the loose "model … error" pattern first, so
  "rate limit reached for model X" or "unauthorized access to model" showed up
  as a Model Error; precise causes are now checked first, messages built by the
  executor are classified by their prefix, and `401`/`429` only match as whole
  numbers (they used to match inside conversation UUIDs). A client cancel gets
  its own "Request Cancelled" category instead of Unknown with install/auth
  hints. `review-changes` keeps git and agy failures apart and formats agy
  failures like the other tools (git stderr mentioning `agy` was reported as
  "Antigravity CLI not found").
- **Prompts leaked into memory, logs and disk:** a map in the logger kept the
  full argv (prompt included) of every spawn that failed to start and was never
  read; debug logs printed tool arguments untruncated; `~/.agy-mcp/bg/<id>.json`
  stored the full argv with the prompt. All three are gone or truncated, and
  files under `~/.agy-mcp/` are now created owner-only (`0600`, dirs `0700`).
- `timeout: 0` silently meant 10 minutes and a negative `timeout` killed `agy`
  right away; foreground tools (ask, plan, digest, review, batch) now require a
  positive integer. stderr of foreground processes was buffered without limit;
  only its last 1 MB is kept now (stdout already had a cap).
- **An explicit `mode` was overridden by skip-permissions:** bg, batch and
  delegate added `--dangerously-skip-permissions` whenever `skipPermissions` was
  omitted, so `mode: "plan"` or `"accept-edits"` still auto-approved every
  command. With a `mode` the default is now off, and `mode: "plan"` together
  with `skipPermissions: true` is rejected.
- `delegate-antigravity` ran `git check-ref-format` on a `branchName` before
  rejecting names that start with `-`; the check now comes first.
- **Error results were inconsistent across tools:** `list-sessions` returned a
  "❌ not found" text as a success; failures to start `bg-antigravity` /
  `delegate-antigravity` turns and `brainstorm` runs came back as raw exceptions
  instead of categorized `❌` errors; `batch-antigravity` threw away its whole
  report when every task failed. All now return `isError` results with the usual
  formatting (batch keeps its report).
- `plan-antigravity` with `format: "json"` showed only "Could not parse JSON"
  for an empty answer; it now shows agy's explanation (usually a denied
  permission), like the markdown format does.
- `digest-antigravity` is marked `openWorldHint: true` (file contents are sent
  to the Antigravity backend).
- `parseAgyErrorLine` gave up at the first stderr line mentioning `AGY_ERROR:`
  even when it carried no JSON; it now takes the first one that parses.
- An empty answer no longer leaves the previous turn's `lastResponse` in the
  session.
- `@path` detection no longer picks up e-mail-like text (`user@host/path`).
- Invalid option combinations (e.g. `mode: "plan"` with `skipPermissions`, an
  effort on Orchestrator) were reported as "Unknown Error" with CLI install
  hints; they now show as "Invalid Arguments" (agy is not started).
- `<id>.agylog` (written by agy itself) was world-readable; it is now created
  owner-only before agy starts.
- A failure opening a background task's `.out` file leaked the already-open
  `.log` descriptor.
- `delegate-antigravity` `action=stop` takes a `signal` (`SIGTERM` default,
  `SIGKILL`, `SIGINT`) like `bg-antigravity`, for runs that ignore SIGTERM.
- `@path` references in a prompt now pick the working directory again — `PWD`
  (practically always set) used to win over them. Order: `workingDir` →
  `AGY_MCP_CWD` → `@path` → launch directory. `@path` is read only from the user's own
  text (ask prompt, digest question, delegate task), never from composed
  prompts that embed diffs or file contents.
- `delegate-antigravity`: calls on the same delegation are serialized (two
  concurrent `continue`s could start two runs in one worktree), and the
  delegation index is updated read-modify-write with an atomic rename instead
  of writing back a stale snapshot.
- Background tasks spawn through `cross-spawn`, so `agy.cmd` shims resolve on
  Windows as they already did for foreground runs.

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
     linked by commit. The 0.3.0 link resolves once the v0.3.0 tag is pushed. -->

[0.3.0]: https://github.com/x51xxx/antigravity-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/x51xxx/antigravity-mcp-server/compare/357898ea2c0709fde911a2950e5adfb204011417...v0.2.0
[0.1.0]: https://github.com/x51xxx/antigravity-mcp-server/commit/357898ea2c0709fde911a2950e5adfb204011417
