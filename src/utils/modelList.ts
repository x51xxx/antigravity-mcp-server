import { executeCommandDetailed } from "./commandExecutor.js";
import { CLI } from "../constants.js";

export interface AgyModel {
  /** Model ID, e.g. "gemini-3.7-flash-high". Accepted by --model. */
  id: string;
  /** Display label, e.g. "Gemini 3.7 Flash (High)". Also accepted by --model. */
  label: string;
}

/**
 * Parse the output of `agy models`.
 *
 * As of CLI v1.1.14 the rows go to stdout as `<id>\t<display label>`, one per
 * model, while the "Fetching available models..." progress line goes to
 * stderr. On a TTY the CLI echoes the rows to stderr as well, so callers may
 * pass both streams — duplicates are collapsed here. CLI v1.0.x printed
 * display labels only, so a row without a tab is kept as a label with no ID.
 */
export function parseModelList(output: string): AgyModel[] {
  const models: AgyModel[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.endsWith("...")) continue;
    const tab = line.indexOf("\t");
    const id = tab === -1 ? "" : line.slice(0, tab).trim();
    const label = tab === -1 ? line : line.slice(tab + 1).trim();
    if (!label || (tab !== -1 && !id)) continue;
    const key = `${id}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id, label });
  }
  return models;
}

/**
 * Run `agy models`. Requires a valid login (the CLI queries the backend), so a
 * non-empty result doubles as an authentication check.
 */
export async function fetchModels(
  onProgress?: (chunk: string) => void,
  timeoutMs = 30000,
): Promise<AgyModel[]> {
  const result = await executeCommandDetailed(
    CLI.COMMANDS.AGY,
    [CLI.SUBCOMMANDS.MODELS],
    { onProgress, timeoutMs },
  );
  if (!result.ok) return [];
  // Rows arrive on stdout; include stderr too (TTY runs echo them there).
  return parseModelList(`${result.stdout}\n${result.stderr}`);
}
