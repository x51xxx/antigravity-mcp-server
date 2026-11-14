/**
 * Parser for `agy -p --output-format stream-json` (CLI v1.5.x).
 *
 * The CLI writes one JSON object per line:
 *   {"event":"init","conversation_id":"<uuid>","init":{"cwd":...,"tools":[...]}}
 *   {"event":"step_update","step_update":{"step_index":N,"state":"ACTIVE|DONE",
 *      "step_type":"user_input|agent_response|tool","tool_name":"run_command",
 *      "text_delta":"...","usage":{...}}}
 *   {"event":"result","result":{"conversation_id":"<uuid>","status":"SUCCESS|ERROR",
 *      "response":"...","error":"...","finished_reason":"print_timeout|interrupted|error",
 *      "duration_seconds":N,"num_turns":N,"usage":{...},"denied_actions":[...]}}
 *
 * The conversation ID is known from the first line, so a long background task
 * can be resumed (`--conversation`) even if it is killed before finishing.
 */

export interface StreamResult {
  conversationId?: string;
  status?: string;
  response?: string;
  error?: string;
  /** Absent when the turn finished normally. */
  finishedReason?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: Record<string, number>;
  deniedActions?: string[];
}

export interface StreamSummary {
  conversationId?: string;
  /** Number of distinct steps seen (user input, responses, tool calls). */
  steps: number;
  /** Completed tool calls, by tool name. */
  toolCalls: Record<string, number>;
  /** The most recent tool call, e.g. `run_command: npm test`. */
  lastTool?: string;
  /** Text of the most recent agent response (streamed deltas joined). */
  lastText: string;
  /** Present once the run has finished. */
  result?: StreamResult;
  /** Lines that were not valid JSON (e.g. a truncated last line). */
  unparsedLines: number;
}

function describeTool(su: Record<string, any>): string {
  const name = String(su.tool_name ?? su.tool_info?.name ?? "tool");
  const params = su.tool_info?.parameters;
  const detail =
    params?.CommandLine ??
    params?.AbsolutePath ??
    params?.TargetFile ??
    params?.Url ??
    params?.Query;
  return detail ? `${name}: ${String(detail).slice(0, 160)}` : name;
}

export function summarizeStreamJson(text: string): StreamSummary {
  const summary: StreamSummary = {
    steps: 0,
    toolCalls: {},
    lastText: "",
    unparsedLines: 0,
  };
  const seenSteps = new Set<number>();
  let textStep: number | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      summary.unparsedLines++;
      continue;
    }

    if (ev.event === "init") {
      summary.conversationId ??= ev.conversation_id || undefined;
    } else if (ev.event === "step_update" && ev.step_update) {
      const su = ev.step_update;
      summary.conversationId ??= su.conversation_id || undefined;
      if (typeof su.step_index === "number") seenSteps.add(su.step_index);
      if (su.step_type === "tool" && su.state === "DONE") {
        const name = String(su.tool_name ?? su.tool_info?.name ?? "tool");
        summary.toolCalls[name] = (summary.toolCalls[name] ?? 0) + 1;
      }
      if (su.step_type === "tool") summary.lastTool = describeTool(su);
      if (su.step_type === "agent_response" && su.text_delta) {
        if (su.step_index !== textStep) {
          textStep = su.step_index;
          summary.lastText = "";
        }
        summary.lastText += su.text_delta;
      }
    } else if (ev.event === "result" && ev.result) {
      const r = ev.result;
      summary.conversationId = r.conversation_id || summary.conversationId;
      summary.result = {
        conversationId: r.conversation_id || undefined,
        status: r.status,
        response: r.response,
        error: r.error || undefined,
        finishedReason: r.finished_reason || undefined,
        durationSeconds: r.duration_seconds,
        numTurns: r.num_turns,
        usage: r.usage,
        deniedActions: Array.isArray(r.denied_actions)
          ? r.denied_actions.map((d: any) => String(d?.action ?? d))
          : undefined,
      };
    }
  }

  summary.steps = seenSteps.size;
  return summary;
}
