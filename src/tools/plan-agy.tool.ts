import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { executeAgy } from "../utils/agyExecutor.js";
import { formatAgyResponseForMCP } from "../utils/outputParser.js";
import { createAgyError, formatErrorForUser } from "../utils/errorTypes.js";

const planArgsSchema = z.object({
  goal: z
    .string()
    .min(1)
    .describe("What you want planned (a feature, refactor, investigation)."),
  contextFiles: z
    .array(z.string())
    .optional()
    .describe("Paths/globs to reference in the prompt."),
  constraints: z
    .string()
    .optional()
    .describe(
      "Hard constraints (must-not-touch areas, style rules, deadlines).",
    ),
  acceptance: z
    .array(z.string())
    .optional()
    .describe("Acceptance criteria the plan must satisfy."),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("json")
    .describe(
      "Output shape. json (default) returns structured steps/risks; markdown returns a checklist.",
    ),
  model: z.string().optional(),
  workingDir: z.string().optional(),
  timeout: z.number().optional(),
});

function buildPrompt(args: {
  goal: string;
  contextFiles?: string[];
  constraints?: string;
  acceptance?: string[];
  format: string;
}): string {
  const refs = (args.contextFiles ?? []).join(", ");

  const formatBlock =
    args.format === "json"
      ? `Return ONLY a JSON object (no prose, no fences) with this exact shape:
{
  "summary": "1-2 sentence statement of the approach",
  "steps": [{"id": 1, "title": "...", "rationale": "...", "files": ["..."], "estimatedComplexity": "low|medium|high"}],
  "filesToTouch": ["..."],
  "filesToRead": ["..."],
  "risks": [{"description": "...", "mitigation": "..."}],
  "openQuestions": ["..."],
  "outOfScope": ["..."]
}`
      : `Return a markdown plan with sections: Summary, Files (read/touch), Steps (checklist), Risks, Open Questions, Out of Scope.`;

  return [
    refs && `Context files: ${refs}`,
    `# GOAL`,
    args.goal,
    args.constraints && `\n# CONSTRAINTS\n${args.constraints}`,
    args.acceptance?.length &&
      `\n# ACCEPTANCE CRITERIA\n${args.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
    `\n# TASK`,
    `Produce an implementation PLAN ONLY. This is a planning request — the caller will execute the work themselves later.`,
    `\n# STRICT RULES (violating these makes the response useless to the caller)`,
    `1. DO NOT use any file-mutation tool (edit, write, create).`,
    `2. DO NOT run shell commands that change state (git commits, npm install, builds, tests that mutate, etc.).`,
    `3. You MAY read files and run read-only commands (e.g., \`ls\`, \`cat\`, \`grep\`) to investigate.`,
    `4. Even if the task looks small, output the plan instead of doing it.`,
    `5. Output ONLY the structured response specified below — no preamble, no "implementation complete" summary.`,
    `\nIdentify files you would touch, in what order, and the smallest correct change for each. Flag risks and open questions.`,
    `\n# OUTPUT`,
    formatBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

function tryExtractJson(raw: string): unknown | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find the first {...} block
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const planAgyTool: UnifiedTool = {
  name: "plan-antigravity",
  description:
    "Generate a structured implementation plan using Antigravity. Use BEFORE coding to get steps, files-to-touch, risks, and open questions. Distinct from ask-antigravity: enforces a plan-only system prompt and parses structured output.",
  zodSchema: planArgsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  category: "utility",
  execute: async (args, onProgress) => {
    const goal = args.goal as string;
    if (!goal?.trim()) throw new Error("goal is required");

    const format = (args.format as string) || "json";
    const prompt = buildPrompt({
      goal,
      contextFiles: args.contextFiles as string[] | undefined,
      constraints: args.constraints as string | undefined,
      acceptance: args.acceptance as string[] | undefined,
      format,
    });

    try {
      const result = await executeAgy(
        prompt,
        {
          model: args.model as string | undefined,
          workingDir: args.workingDir as string | undefined,
          timeout: args.timeout as number | undefined,
        },
        onProgress,
      );

      const text = result.output.trim();

      if (format === "json") {
        const parsed = tryExtractJson(text);
        if (parsed && typeof parsed === "object") {
          return {
            text: text,
            structuredContent: { plan: parsed as Record<string, unknown> },
          };
        }
        // Fallback: return raw text with a warning marker
        return {
          text: `⚠️ Could not parse JSON plan — returning raw output.\n\n${text}`,
          structuredContent: { plan: null, raw: text },
        };
      }

      return formatAgyResponseForMCP(result.output, result.stderr, "clean");
    } catch (error) {
      const agyErr = createAgyError(
        error instanceof Error ? error : String(error),
        {
          model: args.model as string | undefined,
        },
      );
      return `❌ ${formatErrorForUser(agyErr)}`;
    }
  },
};
