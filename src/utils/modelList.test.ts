import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelList } from "./modelList.js";
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
