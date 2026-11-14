import { z } from "zod";
import { AGENT_MODES, EFFORT_LEVELS } from "../constants.js";

/**
 * `--effort`. Each model supports a subset (see the list-models tool): e.g.
 * Gemini 4 Hydrogen low–xhigh, Argon / 3.8 Flash / Claude low–high, GPT-OSS
 * medium only; Orchestrator rejects it. Combine with a base model ID
 * (`gemini-4-hydrogen`) or a suffixed ID whose suffix matches.
 */
export const effortSchema = z
  .enum(EFFORT_LEVELS)
  .optional()
  .describe(
    "Reasoning effort (--effort). Supported levels depend on the model — see list-models. Use with a base model ID (e.g. gemini-4-hydrogen); not supported by Orchestrator.",
  );

/** Signal for stopping a background agy process (sent to its process group). */
export const stopSignalSchema = z
  .enum(["SIGTERM", "SIGKILL", "SIGINT"])
  .optional()
  .default("SIGTERM")
  .describe(
    "Signal for action=stop (default SIGTERM; SIGKILL for a run that ignores it).",
  );

/** `--mode`. Auto is not available on every account (business/enterprise). */
export const modeSchema = z
  .enum(AGENT_MODES)
  .optional()
  .describe(
    "Agent mode (--mode): accept-edits, auto (sandboxed autonomy; not available on every account), or plan (answers go into a plan artifact).",
  );
