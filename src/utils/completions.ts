import { MODELS } from "../constants.js";

export const ARGUMENT_COMPLETIONS: Record<string, string[]> = {
  model: Object.values(MODELS),
  responseMode: ["clean", "full"],
  methodology: [
    "divergent",
    "convergent",
    "scamper",
    "design-thinking",
    "lateral",
    "auto",
  ],
  action: ["list", "delete", "clear"],
};

export function getCompletionValues(
  argName: string,
  partial: string,
): { values: string[]; total: number; hasMore: boolean } {
  const all = ARGUMENT_COMPLETIONS[argName] || [];
  const filtered = partial
    ? all.filter((v) => v.toLowerCase().startsWith(partial.toLowerCase()))
    : all;
  const limited = filtered.slice(0, 100);
  return {
    values: limited,
    total: filtered.length,
    hasMore: filtered.length > 100,
  };
}
