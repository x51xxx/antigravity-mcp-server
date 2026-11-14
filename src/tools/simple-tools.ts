import { z } from "zod";
import { UnifiedTool, StructuredToolResult } from "./registry.js";
import {
  executeCommand,
  executeCommandDetailed,
} from "../utils/commandExecutor.js";
import { fetchModels, groupModelFamilies } from "../utils/modelList.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

const pingArgsSchema = z.object({
  prompt: z.string().default("").describe("Message to echo"),
});

export const pingTool: UnifiedTool = {
  name: "ping",
  description: "Echo",
  zodSchema: pingArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  prompt: { description: "Echo test message with structured response." },
  category: "simple",
  execute: async (args) => (args.prompt || args.message || "Pong!") as string,
};

const helpArgsSchema = z.object({});

export const helpTool: UnifiedTool = {
  name: "Help",
  description: "Show Antigravity CLI help output",
  zodSchema: helpArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  prompt: { description: "Receive help information" },
  category: "simple",
  execute: async (_args, onProgress) => {
    // `agy --help` writes to stderr (and exits non-zero), so read both streams.
    const result = await executeCommandDetailed("agy", ["--help"], {
      onProgress,
    });
    return `${result.stdout}${result.stderr}`.trim() || "(no help output)";
  },
};

const versionArgsSchema = z.object({});

export const versionTool: UnifiedTool = {
  name: "version",
  description: "Display version and system information",
  zodSchema: versionArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: {
    type: "object",
    properties: {
      agyCli: { type: "string" },
      nodeJs: { type: "string" },
      platform: { type: "string" },
      mcpServer: { type: "string" },
    },
    required: ["nodeJs", "platform", "mcpServer"],
  },
  prompt: {
    description: "Get version information for Antigravity CLI and MCP server",
  },
  category: "simple",
  execute: async (_args, onProgress) => {
    const nodeVersion = process.version;
    const platform = process.platform;
    const mcpServer = `${SERVER_NAME} v${SERVER_VERSION}`;

    try {
      const agyVersion = await executeCommand("agy", ["--version"], onProgress);
      return {
        text: `**System Information:**
- Antigravity CLI: ${agyVersion.trim()}
- Node.js: ${nodeVersion}
- Platform: ${platform}
- MCP Server: ${mcpServer}`,
        structuredContent: {
          agyCli: agyVersion.trim(),
          nodeJs: nodeVersion,
          platform,
          mcpServer,
        },
      } as StructuredToolResult;
    } catch {
      return {
        text: `**System Information:**
- Antigravity CLI: Not installed or not accessible
- Node.js: ${nodeVersion}
- Platform: ${platform}
- MCP Server: ${mcpServer}

*Note: Install Antigravity CLI from https://antigravity.google/docs/cli-getting-started*`,
        structuredContent: {
          agyCli: "not installed",
          nodeJs: nodeVersion,
          platform,
          mcpServer,
        },
      } as StructuredToolResult;
    }
  },
};

const listModelsArgsSchema = z.object({});

export const listModelsTool: UnifiedTool = {
  name: "list-models",
  description:
    "List the models available to Antigravity CLI (`agy models`), grouped by family with the `effort` levels each accepts and what it is for. Pass a label, a full ID, or a base ID plus `effort` as the `model` parameter.",
  zodSchema: listModelsArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: {
    type: "object",
    properties: {
      models: { type: "array", items: { type: "string" } },
      modelIds: { type: "array", items: { type: "string" } },
      families: { type: "array" },
    },
    required: ["models"],
  },
  prompt: { description: "List available Antigravity models" },
  category: "simple",
  execute: async (_args, onProgress) => {
    const entries = await fetchModels(onProgress);
    const models = entries.map((m) => m.label);
    const modelIds = entries.map((m) => m.id).filter(Boolean);
    const families = groupModelFamilies(entries);
    const text =
      families.length > 0
        ? `**Available models:**\n\n${families
            .map((f) => {
              const effort = f.efforts.length
                ? `effort: ${f.efforts.join(" | ")} (\`model: "${f.base}", effort: "…"\`)`
                : "fixed thinking level — no effort";
              const rows = f.models
                .map((m) =>
                  m.id ? `  - ${m.label} — \`${m.id}\`` : `  - ${m.label}`,
                )
                .join("\n");
              return `- **${f.name}** — ${effort}${f.purpose ? `\n  ${f.purpose}` : ""}\n${rows}`;
            })
            .join(
              "\n",
            )}\n\nPass a label, a full ID, or a base ID plus \`effort\` as \`model\`.`
        : "(no models returned — is agy authenticated?)";
    return {
      text,
      structuredContent: {
        models,
        modelIds,
        families: families.map((f) => ({
          base: f.base,
          name: f.name,
          efforts: f.efforts,
          purpose: f.purpose,
          models: f.models,
        })),
      },
    } as StructuredToolResult;
  },
};
