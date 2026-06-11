import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { executeAgy } from "../utils/agyExecutor.js";
import {
  formatAgyResponseForMCP,
  ResponseMode,
} from "../utils/outputParser.js";
import { MODELS, ERROR_MESSAGES } from "../constants.js";
import { createAgyError, formatErrorForUser } from "../utils/errorTypes.js";
import {
  getOrCreateSession,
  saveSession,
  getConversationId,
  setConversationId,
  deleteSession,
  withSessionLock,
} from "../utils/sessionStorage.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";

const askAgyArgsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Task or question. Reference files by path — agy reads them with its own tools.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      `Optional model override (display label from \`agy models\`). Known: ${Object.values(
        MODELS,
      ).join(", ")}. If omitted, uses your Antigravity CLI default.`,
    ),
  skipPermissions: z
    .boolean()
    .optional()
    .describe(
      "⚠️ --dangerously-skip-permissions: auto-approve all tool permission requests.",
    ),
  sandbox: z
    .boolean()
    .optional()
    .describe("--sandbox: run with terminal restrictions enabled."),
  cd: z.string().optional().describe("Working directory"),
  workingDir: z
    .string()
    .optional()
    .describe("Working directory for execution (alias of cd)"),
  addDirs: z
    .array(z.string())
    .optional()
    .describe("Additional workspace directories (--add-dir, repeatable)."),
  // Session management
  sessionId: z
    .string()
    .optional()
    .describe(
      "Internal session ID for conversation continuity (workspace-isolated).",
    ),
  conversationId: z
    .string()
    .optional()
    .describe(
      "Native Antigravity conversation ID to resume (--conversation). Overrides sessionId lookup.",
    ),
  resetSession: z
    .boolean()
    .optional()
    .describe(
      "Clear session context before execution. Starts fresh conversation.",
    ),
  continueLatest: z
    .boolean()
    .optional()
    .describe("Use --continue to resume the most recent conversation."),
  // Output shaping
  timeout: z
    .number()
    .optional()
    .describe("Maximum execution time in milliseconds (default 600000)"),
  responseMode: z
    .enum(["clean", "full"])
    .default("clean")
    .describe(
      'Response verbosity: "clean" returns only the final answer (default), "full" includes the stderr execution log.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return the resolved CLI argv as JSON without spawning agy."),
});

export const askAgyTool: UnifiedTool = {
  name: "ask-antigravity",
  description:
    "Execute Google Antigravity CLI (agy) in print mode with model selection, conversation resume, and workspace controls.",
  zodSchema: askAgyArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  prompt: {
    description:
      "Execute Antigravity CLI in print mode with optional session continuity",
  },
  category: "utility",
  execute: async (args, onProgress) => {
    const {
      prompt,
      model,
      skipPermissions,
      sandbox,
      cd,
      workingDir,
      addDirs,
      sessionId,
      conversationId: explicitConversationId,
      resetSession,
      continueLatest,
      timeout,
      responseMode,
      dryRun,
    } = args;

    if (!prompt?.trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    // Serialize calls that share a sessionId so each one observes the
    // conversation ID written by the previous call (preserves resume across
    // concurrent MCP requests).
    return withSessionLock(sessionId as string | undefined, async () => {
      let conversationId = explicitConversationId as string | undefined;
      let activeSessionId: string | undefined;

      if (sessionId) {
        if (resetSession) {
          deleteSession(sessionId as string);
        } else if (!conversationId) {
          conversationId = getConversationId(sessionId as string);
        }
        activeSessionId = sessionId as string;
      }

      const resolvedWorkingDir = resolveWorkingDirectory({
        workingDir: (workingDir || cd) as string,
        prompt: prompt as string,
      });

      let previousResponse: string | undefined;
      if (activeSessionId && resolvedWorkingDir) {
        const session = getOrCreateSession(resolvedWorkingDir, activeSessionId);
        activeSessionId = session.sessionId;
        if (!conversationId) conversationId = session.conversationId;
        previousResponse = session.lastResponse || undefined;
      }

      try {
        const result = await executeAgy(
          prompt as string,
          {
            model: model as string,
            skipPermissions: Boolean(skipPermissions),
            sandbox: Boolean(sandbox),
            cd: cd as string,
            workingDir: workingDir as string,
            addDirs: addDirs as string[] | undefined,
            conversationId,
            continueLatest: Boolean(continueLatest),
            timeout: timeout as number | undefined,
            dryRun: Boolean(dryRun),
          },
          onProgress,
        );

        // When resuming, agy print mode replays the previous assistant message
        // before the new one. Strip it when we know the full prior response
        // (lastResponse is stored truncated at 1000 chars — only strip when
        // it was short enough to be complete).
        let outputText = result.output;
        if (
          conversationId &&
          previousResponse &&
          previousResponse.length < 1000 &&
          outputText.startsWith(previousResponse)
        ) {
          outputText = outputText
            .slice(previousResponse.length)
            .replace(/^\n+/, "");
        }

        if (activeSessionId) {
          if (result.conversationId) {
            setConversationId(activeSessionId, result.conversationId);
          }
          saveSession({
            sessionId: activeSessionId,
            lastPrompt: prompt as string,
            lastResponse: outputText.substring(0, 1000),
            model: model as string,
            workingDir: resolvedWorkingDir,
          });
        }

        return formatAgyResponseForMCP(
          outputText,
          result.stderr,
          (responseMode as ResponseMode) || "clean",
        );
      } catch (error) {
        const agyErr = createAgyError(
          error instanceof Error ? error : String(error),
          {
            sessionId: activeSessionId,
            model: model as string,
            workingDir: resolvedWorkingDir,
          },
        );
        return `❌ ${formatErrorForUser(agyErr)}`;
      }
    });
  },
};
