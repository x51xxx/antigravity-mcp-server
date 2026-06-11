import { Logger } from "./logger.js";

export type ResponseMode = "clean" | "full";

export interface AgyOutput {
  /** Final response text — what a clean-mode caller wants. */
  response: string;
  rawStdout: string;
  rawStderr?: string;
}

/**
 * Antigravity CLI print mode emits plain text on stdout (no JSONL stream
 * format as of v1.0.7). When resuming a conversation, the CLI may replay the
 * previous assistant message before the new one — both end up on stdout; we
 * keep everything and let "clean" mode return it verbatim.
 */
export function parseAgyOutput(
  rawStdout: string,
  rawStderr?: string,
): AgyOutput {
  const trimmed = rawStdout.trim();
  if (trimmed) Logger.agyResponse(trimmed);
  return {
    response: trimmed,
    rawStdout,
    rawStderr,
  };
}

export function formatAgyResponseFull(output: AgyOutput): string {
  const stderr = output.rawStderr || "";

  if (!stderr.trim() && !output.response) return "(empty response)";

  let formatted = "";
  if (stderr.trim()) {
    formatted += `**Execution Log (stderr):**\n\`\`\`\n${stderr.trim()}\n\`\`\`\n\n`;
  }
  formatted += `**Final Response:**\n${output.response || "(empty)"}`;
  return formatted;
}

export function formatAgyResponseForMCP(
  result: string,
  stderr?: string,
  responseMode: ResponseMode = "clean",
): string {
  const parsed = parseAgyOutput(result, stderr);
  if (responseMode === "full") return formatAgyResponseFull(parsed);
  return parsed.response || "(empty response)";
}

export function extractCodeBlocks(text: string): string[] {
  const re = /```[\s\S]*?```/g;
  return text.match(re) || [];
}

export function extractDiffBlocks(text: string): string[] {
  const re = /```diff[\s\S]*?```/g;
  return text.match(re) || [];
}

export function isErrorResponse(output: AgyOutput | string): boolean {
  const keywords = [
    "error",
    "failed",
    "unable",
    "cannot",
    "authentication",
    "permission denied",
    "rate limit",
    "quota exceeded",
  ];
  const text =
    typeof output === "string"
      ? output.toLowerCase()
      : output.response.toLowerCase();
  return keywords.some((k) => text.includes(k));
}
