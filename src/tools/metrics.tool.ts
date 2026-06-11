import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { metrics } from "../utils/metrics.js";

const metricsArgsSchema = z.object({});

export const metricsTool: UnifiedTool = {
  name: "metrics",
  description: "Expose Prometheus-formatted metrics for Antigravity MCP server",
  zodSchema: metricsArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  category: "simple",
  execute: async () => {
    return metrics.getPrometheusMetrics();
  },
};
