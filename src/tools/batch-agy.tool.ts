import { z } from "zod";
import { UnifiedTool, StructuredToolResult } from "./registry.js";
import { executeAgy } from "../utils/agyExecutor.js";
import { MODELS } from "../constants.js";

const batchTaskSchema = z.object({
  task: z.string().describe("Atomic task description"),
  target: z
    .string()
    .optional()
    .describe("Target files/directories (referenced by path)"),
  priority: z
    .enum(["high", "normal", "low"])
    .default("normal")
    .describe("Task priority"),
});

type BatchTask = z.infer<typeof batchTaskSchema>;

interface BatchTaskResult {
  task: string;
  status: "success" | "failed" | "skipped";
  output?: string;
  error?: string;
}

const batchAgyArgsSchema = z.object({
  tasks: z
    .array(batchTaskSchema)
    .min(1)
    .describe("Array of atomic tasks to delegate to Antigravity"),
  model: z
    .string()
    .optional()
    .describe(
      `Optional model override applied to every task. Known: ${Object.values(MODELS).join(", ")}.`,
    ),
  skipPermissions: z
    .boolean()
    .default(true)
    .describe(
      "--dangerously-skip-permissions (typical for batch jobs — print mode can't answer prompts)",
    ),
  parallel: z
    .boolean()
    .default(false)
    .describe("Execute independent tasks in parallel"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Maximum parallel agy processes when parallel=true. Default: min(task count, 4)",
    ),
  stopOnError: z
    .boolean()
    .default(true)
    .describe("Stop execution if any task fails"),
  timeout: z
    .number()
    .optional()
    .describe("Maximum execution time per task in milliseconds"),
  workingDir: z.string().optional().describe("Working directory for execution"),
});

export const batchAgyTool: UnifiedTool = {
  name: "batch-antigravity",
  description:
    "Delegate multiple atomic tasks to Antigravity for batch processing. Ideal for repetitive operations, mass refactoring, and automated transformations.",
  zodSchema: batchAgyArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  outputSchema: {
    type: "object",
    properties: {
      total: { type: "number" },
      successful: { type: "number" },
      failed: { type: "number" },
      skipped: { type: "number" },
      results: { type: "array" },
    },
    required: ["total", "successful", "failed", "skipped", "results"],
  },
  prompt: {
    description:
      "Execute multiple atomic Antigravity tasks in batch mode for efficient automation",
  },
  category: "agy",
  execute: async (args, onProgress) => {
    const {
      tasks,
      model,
      skipPermissions,
      parallel,
      concurrency,
      stopOnError,
      timeout,
      workingDir,
    } = args;
    const taskList = tasks as BatchTask[];

    if (!taskList || taskList.length === 0) {
      throw new Error("No tasks provided for batch execution");
    }

    const sortedTasks = [...taskList].sort((a, b) => {
      const order = { high: 0, normal: 1, low: 2 };
      return (
        order[a.priority as keyof typeof order] -
        order[b.priority as keyof typeof order]
      );
    });

    const results: BatchTaskResult[] = new Array(sortedTasks.length);
    let failedCount = 0;
    let successCount = 0;
    let skippedCount = 0;

    if (onProgress) {
      const mode = parallel
        ? `parallel mode (concurrency ${Math.min(
            (concurrency as number | undefined) ?? 4,
            sortedTasks.length,
          )})`
        : "sequential mode";
      onProgress(
        `🚀 Starting batch execution of ${sortedTasks.length} tasks in ${mode}...`,
      );
    }

    const runTask = async (i: number): Promise<void> => {
      const task = sortedTasks[i];
      const taskPrompt = task.target
        ? `${task.task} in ${task.target}`
        : task.task;

      if (onProgress)
        onProgress(
          `\n[${i + 1}/${sortedTasks.length}] Executing: ${taskPrompt}`,
        );

      try {
        const result = await executeAgy(
          taskPrompt,
          {
            model: model as string,
            skipPermissions: Boolean(skipPermissions),
            timeout: timeout as number,
            workingDir: workingDir as string,
          },
          undefined,
        );

        results[i] = {
          task: taskPrompt,
          status: "success",
          output: (
            result.output.trim() ||
            result.stderr.trim() ||
            result.output
          ).substring(0, 500),
        };
        successCount++;

        if (onProgress) onProgress(`✅ Completed: ${task.task}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        results[i] = {
          task: taskPrompt,
          status: "failed",
          error: errorMessage,
        };
        failedCount++;
        if (onProgress) onProgress(`❌ Failed: ${task.task} - ${errorMessage}`);
      }
    };

    if (parallel) {
      let nextIdx = 0;
      let stop = false;
      const workers = Math.min(
        (concurrency as number | undefined) ?? 4,
        sortedTasks.length,
      );

      const worker = async (): Promise<void> => {
        while (!stop) {
          const idx = nextIdx++;
          if (idx >= sortedTasks.length) return;
          await runTask(idx);
          if (stopOnError && results[idx]?.status === "failed") stop = true;
        }
      };

      await Promise.all(Array.from({ length: workers }, () => worker()));

      if (stopOnError) {
        for (let i = 0; i < sortedTasks.length; i++) {
          if (!results[i]) {
            const t = sortedTasks[i];
            const taskPrompt = t.target ? `${t.task} in ${t.target}` : t.task;
            results[i] = {
              task: taskPrompt,
              status: "skipped",
              error: "Skipped due to previous failure",
            };
            skippedCount++;
          }
        }
      }
    } else {
      for (let i = 0; i < sortedTasks.length; i++) {
        const t = sortedTasks[i];
        const taskPrompt = t.target ? `${t.task} in ${t.target}` : t.task;
        if (stopOnError && failedCount > 0) {
          results[i] = {
            task: taskPrompt,
            status: "skipped",
            error: "Skipped due to previous failure",
          };
          skippedCount++;
          continue;
        }
        await runTask(i);
      }
    }

    let report = `\n📊 **Batch Execution Summary**\n`;
    report += `\n- Total tasks: ${sortedTasks.length}`;
    report += `\n- Successful: ${successCount} ✅`;
    report += `\n- Failed: ${failedCount} ❌`;
    report += `\n- Skipped: ${skippedCount} ⏭️`;
    report += `\n\n**Task Results:**\n`;
    for (const r of results) {
      const icon =
        r.status === "success" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
      report += `\n${icon} **${r.task}**`;
      if (r.status === "success" && r.output) {
        report += `\n   Output: ${r.output.substring(0, 100)}...`;
      } else if (r.error) {
        report += `\n   Error: ${r.error}`;
      }
    }

    if (failedCount === sortedTasks.length) {
      throw new Error(
        `All ${failedCount} tasks failed. See report above for details.`,
      );
    }

    return {
      text: report,
      structuredContent: {
        total: sortedTasks.length,
        successful: successCount,
        failed: failedCount,
        skipped: skippedCount,
        results,
      },
    } as StructuredToolResult;
  },
};
