import { executeCommandDetailed } from "./commandExecutor.js";
import { CLI, MODEL_FAMILIES, EFFORT_LEVELS } from "../constants.js";

export interface AgyModel {
  /** Model ID, e.g. "gemini-4-hydrogen-high". Accepted by --model. */
  id: string;
  /** Display label, e.g. "Gemini 4 Hydrogen (High)". Also accepted by --model. */
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

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/**
 * Split a model ID into its base ID and effort suffix:
 * "gemini-4-hydrogen-xhigh" → { base: "gemini-4-hydrogen", effort: "xhigh" }.
 * IDs without a suffix (e.g. the Orchestrator) come back with no effort.
 */
export function splitModelId(id: string): { base: string; effort?: string } {
  const m = id.match(EFFORT_SUFFIX);
  if (!m) return { base: id };
  return { base: id.slice(0, -m[0].length), effort: m[1] };
}

export interface ModelFamily {
  /** Base model ID — pass it as `model` together with `effort`. */
  base: string;
  /** Human-readable family name. */
  name: string;
  /** Effort levels offered by `agy models` for this family, lowest first. */
  efforts: string[];
  /** The full rows of this family. */
  models: AgyModel[];
  /** Intended use, when the Antigravity docs describe one. */
  purpose?: string;
}

/**
 * Group `agy models` rows by base model ID so callers can see which `effort`
 * values each model accepts. Families keep the order of first appearance.
 * Label-only rows (CLI 1.0.x) each form their own family.
 */
export function groupModelFamilies(models: AgyModel[]): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const m of models) {
    const { base, effort } = m.id ? splitModelId(m.id) : { base: m.label };
    let fam = families.get(base);
    if (!fam) {
      const known = MODEL_FAMILIES[base];
      fam = {
        base,
        name: known?.name ?? m.label.replace(/\s*\([^)]*\)\s*$/, ""),
        efforts: [],
        models: [],
        purpose: known?.purpose,
      };
      families.set(base, fam);
    }
    fam.models.push(m);
    if (effort && !fam.efforts.includes(effort)) fam.efforts.push(effort);
  }
  const rank = (e: string) => (EFFORT_LEVELS as readonly string[]).indexOf(e);
  for (const fam of families.values()) {
    fam.efforts.sort((x, y) => rank(x) - rank(y));
  }
  return [...families.values()];
}

/**
 * Pick the Orchestrator model to use for long delegated tasks, preferring the
 * Carbon planner (deeper reasoning, Ultra-only) over Argon. Returns undefined
 * when the account offers no Orchestrator.
 */
export function pickOrchestrator(models: AgyModel[]): AgyModel | undefined {
  const orchestrators = models.filter((m) => /^orchestrator\b/i.test(m.label));
  return orchestrators.find((m) => /carbon/i.test(m.label)) ?? orchestrators[0];
}

/** True when the model (ID or label) is an Orchestrator, which rejects --effort. */
export function isOrchestratorModel(model: string): boolean {
  return /orchestrator/i.test(model);
}
