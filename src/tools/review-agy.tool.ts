import { z } from "zod";
import { UnifiedTool, toolError } from "./registry.js";
import { executeCommandDetailed } from "../utils/commandExecutor.js";
import { executeAgyCLI } from "../utils/agyExecutor.js";
import { createAgyError, formatErrorForUser } from "../utils/errorTypes.js";
import { MODELS } from "../constants.js";
import { Logger } from "../utils/logger.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";
import { effortSchema } from "./sharedSchemas.js";
import { READ_ONLY_PROMPT_NOTE } from "../constants.js";

const reviewAgyArgsSchema = z.object({
  prompt: z
    .string()
    .optional()
    .describe("Custom review instructions or focus areas (optional)"),
  uncommitted: z
    .boolean()
    .optional()
    .describe("Review staged + unstaged + untracked changes (working tree)"),
  base: z
    .string()
    .optional()
    .describe(
      'Review changes against a specific base branch (e.g., "main", "develop")',
    ),
  commit: z
    .string()
    .optional()
    .describe("Review changes introduced by a specific commit SHA"),
  title: z
    .string()
    .optional()
    .describe("Optional title for the review summary"),
  model: z
    .string()
    .optional()
    .describe(
      `Optional model override. Known: ${Object.values(MODELS).join(", ")}. If omitted, uses your Antigravity CLI default.`,
    ),
  effort: effortSchema,
  workingDir: z
    .string()
    .optional()
    .describe("Working directory to run the review in"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum execution time in milliseconds"),
});

/**
 * Antigravity CLI does not ship a native `review` subcommand. We collect the
 * relevant diff via git ourselves, embed it in a focused review prompt, and
 * execute through the standard print-mode pipeline.
 */
async function collectDiff(
  workingDir: string,
  opts: { uncommitted?: boolean; base?: string; commit?: string },
): Promise<string> {
  // `commit` / `base` come from the MCP caller. A value starting with "-"
  // would be parsed by git as an option (e.g. `--output=<file>` writes an
  // arbitrary file), so reject it and end option parsing explicitly.
  for (const [name, value] of Object.entries({
    commit: opts.commit,
    base: opts.base,
  })) {
    if (value && value.startsWith("-")) {
      throw new Error(`Invalid ${name} "${value}": must be a git revision.`);
    }
  }
  const args: string[] = [];
  if (opts.commit) {
    args.push("show", "--stat", "--patch", "--end-of-options", opts.commit);
  } else if (opts.base) {
    args.push(
      "diff",
      "--stat",
      "--patch",
      "--end-of-options",
      `${opts.base}...HEAD`,
    );
  } else {
    // Default: diff against tracked HEAD (covers staged + unstaged)
    args.push("diff", "HEAD", "--stat", "--patch");
  }

  const result = await executeCommandDetailed("git", args, {
    cwd: workingDir,
    timeoutMs: 30000,
  });

  if (!result.ok) {
    throw new Error(
      result.spawnNotFound
        ? "git not found. Install git and run inside a git repository."
        : `git ${args[0]} failed: ${result.stderr || `exit ${result.code}`}`,
    );
  }

  let untracked = "";
  if (opts.uncommitted) {
    const ls = await executeCommandDetailed(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: workingDir, timeoutMs: 10000 },
    );
    if (ls.ok && ls.stdout.trim()) {
      untracked = `\n\n## Untracked files\n\n${ls.stdout.trim()}`;
    }
  }

  return result.stdout + untracked;
}

function buildReviewPrompt(
  diff: string,
  opts: { prompt?: string; base?: string; commit?: string; title?: string },
): string {
  const focus = opts.prompt ? `\n## Custom focus\n${opts.prompt}\n` : "";

  const scope = opts.commit
    ? `commit \`${opts.commit}\``
    : opts.base
      ? `branch diff vs \`${opts.base}\``
      : "working tree changes";

  return `# Code Review${opts.title ? `: ${opts.title}` : ""}

You are reviewing ${scope}. Focus on:
- correctness and edge cases
- security and input validation
- performance (when meaningful)
- readability, naming, comments
- test coverage and gaps

For each finding, output:
- **File:line** — short title
- Severity: critical | major | minor | nit
- One-paragraph explanation
- Suggested fix (code snippet when useful)

End with a brief summary section: ship / ship with fixes / block.

${READ_ONLY_PROMPT_NOTE} The diff below is complete; do not try to apply fixes.
${focus}
## Diff
\`\`\`diff
${diff.length > 200000 ? diff.substring(0, 200000) + "\n\n[... truncated for context limits ...]" : diff}
\`\`\`
`;
}

export const reviewAgyTool: UnifiedTool = {
  name: "review-changes",
  description:
    "Run a code review against the current repository using Antigravity (collects git diff + structured review prompt).",
  zodSchema: reviewAgyArgsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  prompt: {
    description:
      "Review uncommitted changes / branch diff / specific commit with Antigravity",
  },
  category: "agy",
  execute: async (args, onProgress) => {
    const {
      prompt,
      uncommitted,
      base,
      commit,
      title,
      model,
      effort,
      workingDir,
      timeout,
    } = args;

    // Collecting the diff and running agy fail for different reasons; keep
    // them apart so git's stderr is never classified as an agy failure (a
    // missing file named agy.ts used to read as "Antigravity CLI not found").
    let resolvedDir: string;
    let diff: string;
    try {
      onProgress?.("Collecting git diff...");
      resolvedDir =
        resolveWorkingDirectory({ workingDir: workingDir as string }) ||
        process.cwd();
      diff = await collectDiff(resolvedDir, {
        uncommitted: uncommitted as boolean | undefined,
        base: base as string | undefined,
        commit: commit as string | undefined,
      });
    } catch (error) {
      Logger.error("Review: collecting the diff failed:", error);
      return toolError(
        `❌ **Review Failed**: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!diff.trim()) {
      return "✅ No changes to review.";
    }

    try {
      const reviewPrompt = buildReviewPrompt(diff, {
        prompt: prompt as string | undefined,
        base: base as string | undefined,
        commit: commit as string | undefined,
        title: title as string | undefined,
      });

      onProgress?.("Running Antigravity review...");

      const response = await executeAgyCLI(
        reviewPrompt,
        {
          model: model as string | undefined,
          effort: effort as string | undefined,
          workingDir: resolvedDir,
          timeoutMs: (timeout as number) || 600000,
          // The diff is untrusted input: run in Default agent mode so the
          // reviewer cannot apply edits.
          readOnly: true,
        },
        onProgress,
      );

      const header = `## Code Review Results\n\n**Model:** ${model ?? "Antigravity CLI default"}\n${
        base ? `**Base:** ${base}\n` : ""
      }${commit ? `**Commit:** ${commit}\n` : ""}${title ? `**Title:** ${title}\n` : ""}\n`;

      return header + response;
    } catch (error) {
      Logger.error("Review failed:", error);
      const agyErr = createAgyError(
        error instanceof Error ? error : String(error),
        { model: model as string | undefined, workingDir: resolvedDir },
      );
      return toolError(`❌ ${formatErrorForUser(agyErr)}`);
    }
  },
};
