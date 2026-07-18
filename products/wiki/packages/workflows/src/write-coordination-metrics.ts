export interface WriteCoordinationMetricSnapshot {
  acquisitions: Array<{ backend: "local" | "postgres"; operation: string; status: "acquired" | "busy" | "error"; count: number }>;
  wait_seconds_total: Array<{ backend: "local" | "postgres"; operation: string; seconds: number }>;
  hold_seconds_total: Array<{ backend: "local" | "postgres"; operation: string; seconds: number }>;
}

const writeCoordinationMetricCounters = new Map<string, number>();

export function writeCoordinationMetricsSnapshot(): WriteCoordinationMetricSnapshot {
  const acquisitions: WriteCoordinationMetricSnapshot["acquisitions"] = [];
  const wait_seconds_total: WriteCoordinationMetricSnapshot["wait_seconds_total"] = [];
  const hold_seconds_total: WriteCoordinationMetricSnapshot["hold_seconds_total"] = [];
  for (const [key, value] of writeCoordinationMetricCounters) {
    const [kind, backend = "local", operation = "unknown", status = ""] = key.split("|");
    if (kind === "acquire" && (backend === "local" || backend === "postgres") && (status === "acquired" || status === "busy" || status === "error")) {
      acquisitions.push({ backend, operation, status, count: value });
    }
    if (kind === "wait_seconds" && (backend === "local" || backend === "postgres")) {
      wait_seconds_total.push({ backend, operation, seconds: value });
    }
    if (kind === "hold_seconds" && (backend === "local" || backend === "postgres")) {
      hold_seconds_total.push({ backend, operation, seconds: value });
    }
  }
  return { acquisitions, wait_seconds_total, hold_seconds_total };
}

export function incrementWriteCoordinationMetric(key: string, value: number): void {
  writeCoordinationMetricCounters.set(key, (writeCoordinationMetricCounters.get(key) ?? 0) + value);
}

export function resetWriteCoordinationMetricsForTests(): void {
  writeCoordinationMetricCounters.clear();
}
