import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelList,
  splitModelId,
  groupModelFamilies,
  pickOrchestrator,
  isOrchestratorModel,
} from "./modelList.js";
import { MODELS } from "../constants.js";

// Verbatim `agy models` output (CLI v1.1.14): tab-separated rows on stdout,
// preceded by the progress line the CLI emits on stderr.
const AGY_1_1_14 = [
  "Fetching available models...",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

test("parses the tab-separated id/label rows of CLI v1.1.14", () => {
  const models = parseModelList(AGY_1_1_14);
  assert.equal(models.length, 6);
  assert.deepEqual(models[0], {
    id: "gemini-3.7-flash-high",
    label: "Gemini 3.7 Flash (High)",
  });
  assert.deepEqual(models.at(-1), {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
  });
});

test("drops the 'Fetching available models...' progress line", () => {
  assert.ok(
    !parseModelList(AGY_1_1_14).some((m) => m.label.includes("Fetching")),
  );
});

test("falls back to label-only rows (CLI v1.0.x format)", () => {
  const models = parseModelList(
    "Gemini 3.1 Pro (Low)\nGPT-OSS 120B (Medium)\n",
  );
  assert.deepEqual(models, [
    { id: "", label: "Gemini 3.1 Pro (Low)" },
    { id: "", label: "GPT-OSS 120B (Medium)" },
  ]);
});

test("returns nothing for empty or progress-only output", () => {
  assert.deepEqual(parseModelList(""), []);
  assert.deepEqual(parseModelList("\n  \nFetching available models...\n"), []);
});

test("collapses rows duplicated across stdout and stderr (TTY runs)", () => {
  const row = "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)";
  assert.deepEqual(parseModelList(`${row}\n${row}`), [
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  ]);
});

test("every label in MODELS is unique and non-empty", () => {
  const labels = Object.values(MODELS);
  assert.ok(labels.every((l) => l.trim().length > 0));
  assert.equal(new Set(labels).size, labels.length);
});

// Verbatim `agy models` stdout (CLI v1.5.9, Google AI Pro account).
const AGY_1_5_9 = [
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "gemini-4-argon-low\tGemini 4 Argon (Low)",
  "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
  "gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

test("splitModelId separates the effort suffix", () => {
  assert.deepEqual(splitModelId("gemini-4-hydrogen-xhigh"), {
    base: "gemini-4-hydrogen",
    effort: "xhigh",
  });
  assert.deepEqual(splitModelId("gemini-3.8-flash-low"), {
    base: "gemini-3.8-flash",
    effort: "low",
  });
  assert.deepEqual(splitModelId("gemini-pro-orchestrator-g1-pro"), {
    base: "gemini-pro-orchestrator-g1-pro",
  });
});

test("groupModelFamilies collects effort levels per base model (v1.5.9)", () => {
  const fams = groupModelFamilies(parseModelList(AGY_1_5_9));
  const byBase = Object.fromEntries(fams.map((f) => [f.base, f]));
  assert.deepEqual(byBase["gemini-4-hydrogen"].efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(byBase["gemini-4-argon"].efforts, ["low", "medium", "high"]);
  assert.deepEqual(byBase["gemini-pro-orchestrator-g1-pro"].efforts, []);
  assert.equal(
    byBase["gemini-pro-orchestrator-g1-pro"].name,
    "Orchestrator (Argon)",
  );
  assert.ok(byBase["gemini-4-hydrogen"].purpose);
  assert.equal(byBase["gemini-4-hydrogen"].models.length, 4);
});

test("groupModelFamilies keeps label-only rows (v1.0.x) as their own family", () => {
  const fams = groupModelFamilies(parseModelList("Gemini 3.1 Pro (Low)\n"));
  assert.equal(fams.length, 1);
  assert.equal(fams[0].name, "Gemini 3.1 Pro");
  assert.deepEqual(fams[0].efforts, []);
});

test("pickOrchestrator prefers Carbon, falls back to Argon, else undefined", () => {
  const argonOnly = parseModelList(AGY_1_5_9);
  assert.equal(
    pickOrchestrator(argonOnly)?.id,
    "gemini-pro-orchestrator-g1-pro",
  );
  const both = [
    ...argonOnly,
    { id: "gemini-ultra-orchestrator-carbon", label: "Orchestrator (Carbon)" },
  ];
  assert.equal(pickOrchestrator(both)?.label, "Orchestrator (Carbon)");
  assert.equal(
    pickOrchestrator(
      parseModelList("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)"),
    ),
    undefined,
  );
});

test("isOrchestratorModel matches IDs and labels", () => {
  assert.ok(isOrchestratorModel("gemini-pro-orchestrator-g1-pro"));
  assert.ok(isOrchestratorModel("Orchestrator (Argon)"));
  assert.ok(!isOrchestratorModel("gemini-4-argon-high"));
});
