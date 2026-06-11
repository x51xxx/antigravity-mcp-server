import { z } from "zod";
import { UnifiedTool, StructuredToolResult } from "./registry.js";
import { executeCommand } from "../utils/commandExecutor.js";

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
    return executeCommand("agy", ["--help"], onProgress);
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
    const mcpServer = "@trishchuk/antigravity-mcp-server v0.1.0";

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
    "List model labels currently available to Antigravity CLI (`agy models`). Use these exact labels for the `model` parameter.",
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
    },
    required: ["models"],
  },
  prompt: { description: "List available Antigravity models" },
  category: "simple",
  execute: async (_args, onProgress) => {
    const output = await executeCommand("agy", ["models"], onProgress, 30000);
    const models = output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      text:
        models.length > 0
          ? `**Available models:**\n${models.map((m) => `- ${m}`).join("\n")}`
          : "(no models returned — is agy authenticated?)",
      structuredContent: { models },
    } as StructuredToolResult;
  },
};
