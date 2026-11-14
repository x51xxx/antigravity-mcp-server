import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, ErrorCategory as C } from "./errorTypes.js";
import { describeAgyFailure } from "./agyExecutor.js";

test("specific causes win over the loose 'model … error' pattern", () => {
  const cases: [string, C][] = [
    [
      "Antigravity agent error (exit 3): rate limit reached for model gemini-4-hydrogen",
      C.RATE_LIMIT,
    ],
    [
      "Antigravity agent error (exit 3): unauthorized access to model",
      C.AUTHENTICATION,
    ],
    [
      "Antigravity agent error (exit 3): request timed out while the model was thinking",
      C.TIMEOUT,
    ],
    [
      "Antigravity agent error (exit 3): RESOURCE_EXHAUSTED for model X",
      C.RATE_LIMIT,
    ],
    [
      "Model error: invalid model selection (effort xhigh not supported)",
      C.MODEL,
    ],
    ["Antigravity agent error (exit 3): model returned an error", C.MODEL],
  ];
  for (const [msg, want] of cases) assert.equal(classifyError(msg), want, msg);
});

test("executor messages are classified by their prefix, not the CLI text after it", () => {
  assert.equal(
    classifyError(
      "Rate limit exceeded. Please wait and try again: error from model",
    ),
    C.RATE_LIMIT,
  );
  assert.equal(
    classifyError("Antigravity CLI timed out after 600000ms"),
    C.TIMEOUT,
  );
  const auth = describeAgyFailure({
    code: 1,
    stdout: "",
    stderr: "not authenticated; model unavailable",
    timedOut: false,
    timeoutMs: 1000,
  });
  assert.equal(classifyError(auth), C.AUTHENTICATION);
});

test("a client cancellation has its own category", () => {
  const msg = describeAgyFailure({
    code: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: true,
    timeoutMs: 1000,
  });
  assert.equal(classifyError(msg), C.CANCELLED);
});

test("status codes only match as whole numbers (not inside UUIDs)", () => {
  assert.equal(
    classifyError(
      "conversation 4401a2b0-1429-4bcd-8401-000000000000 failed to resume",
    ),
    C.SESSION,
  );
  assert.equal(classifyError("HTTP 401 from backend"), C.AUTHENTICATION);
  assert.equal(classifyError("HTTP 429"), C.RATE_LIMIT);
});

test("argument validation errors are not reported as agy failures", async () => {
  const { AgyCommandBuilder } = await import("./agyCommandBuilder.js");
  await assert.rejects(
    new AgyCommandBuilder().build("x", { mode: "plan", skipPermissions: true }),
    (err: Error) => {
      assert.equal(classifyError(err.message), C.INVALID_ARGUMENTS);
      return true;
    },
  );
});
