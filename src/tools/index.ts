import { toolRegistry } from "./registry.js";
import { askAgyTool } from "./ask-agy.tool.js";
import { batchAgyTool } from "./batch-agy.tool.js";
import { reviewAgyTool } from "./review-agy.tool.js";
import { planAgyTool } from "./plan-agy.tool.js";
import { brainstormTool } from "./brainstorm.tool.js";
import { bgAgyTool } from "./bg-agy.tool.js";
import { digestAgyTool } from "./digest-agy.tool.js";
import { delegateAgyTool } from "./delegate-agy.tool.js";
import { listSessionsTool } from "./list-sessions.tool.js";
import { healthTool } from "./health.tool.js";
import {
  pingTool,
  helpTool,
  versionTool,
  listModelsTool,
} from "./simple-tools.js";
import { metricsTool } from "./metrics.tool.js";

toolRegistry.push(
  askAgyTool,
  batchAgyTool,
  reviewAgyTool,
  planAgyTool,
  brainstormTool,
  bgAgyTool,
  digestAgyTool,
  delegateAgyTool,
  listSessionsTool,
  healthTool,
  listModelsTool,
  pingTool,
  helpTool,
  versionTool,
  metricsTool,
);

export * from "./registry.js";
