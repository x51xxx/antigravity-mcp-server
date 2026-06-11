export class MetricsCollector {
  private agyInvocations = 0;

  incrementAgyInvocations(): void {
    this.agyInvocations++;
  }

  getAgyInvocationsTotal(): number {
    return this.agyInvocations;
  }

  resetForTesting(): void {
    this.agyInvocations = 0;
  }

  getPrometheusMetrics(): string {
    return [
      "# HELP agy_invocations_total Total number of Antigravity CLI invocations",
      "# TYPE agy_invocations_total counter",
      `agy_invocations_total ${this.agyInvocations}`,
      "",
    ].join("\n");
  }
}

export const metrics = new MetricsCollector();
