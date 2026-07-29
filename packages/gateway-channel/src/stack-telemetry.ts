import {
  channelProviderKindFromId,
  isChannelProviderKind,
  type ChannelProviderKind,
} from "./provider.js";

export const CHANNEL_STACK_TELEMETRY_SCHEMA_VERSION = "2";

export type ChannelTelemetrySurface =
  | "cloud-channel-gateway"
  | "standalone-gateway"
  | "durable-gateway";

export type ChannelTelemetryStack = "monorepo-provider" | "durable-native";
export type ChannelTelemetryDirection = "inbound" | "outbound";
export type ChannelTelemetryOutcome = "attempt" | "success" | "retry" | "error" | "ignored";
export type ChannelTelemetryBindingStatus = "configured" | "active";

type OperationInput = {
  stack: ChannelTelemetryStack;
  providerKind: ChannelProviderKind | string;
  direction: ChannelTelemetryDirection;
  outcome: ChannelTelemetryOutcome;
  latencyMs?: number;
};

type Histogram = {
  counts: number[];
  sum: number;
  count: number;
};

const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];
const DIRECTIONS: ChannelTelemetryDirection[] = ["inbound", "outbound"];
const OUTCOMES: ChannelTelemetryOutcome[] = ["attempt", "success", "retry", "error", "ignored"];

export class ChannelStackTelemetry {
  readonly surface: ChannelTelemetrySurface;
  private readonly stacks = new Set<ChannelTelemetryStack>();
  private readonly bindings = new Map<string, number>();
  private readonly messages = new Map<string, number>();
  private readonly latencies = new Map<string, Histogram>();

  constructor(surface: ChannelTelemetrySurface, stacks: ChannelTelemetryStack[] = []) {
    this.surface = surface;
    for (const stack of stacks) this.declareStack(stack);
  }

  declareStack(stack: ChannelTelemetryStack): void {
    this.stacks.add(stack);
  }

  setBindingCount(
    stack: ChannelTelemetryStack,
    providerKind: ChannelProviderKind | string,
    status: ChannelTelemetryBindingStatus,
    count: number,
  ): void {
    const kind = boundedProviderKind(providerKind);
    this.declareStack(stack);
    this.bindings.set(bindingKey(stack, kind, status), Math.max(0, Math.floor(count)));
    // A declared, configured surface with no traffic is a real zero. An
    // undeployed stack has no info series at all, preserving absent-vs-zero.
    for (const direction of DIRECTIONS) {
      for (const outcome of OUTCOMES) {
        const key = operationKey(stack, kind, direction, outcome);
        if (!this.messages.has(key)) this.messages.set(key, 0);
      }
    }
  }

  recordOperation(input: OperationInput): void {
    const kind = boundedProviderKind(input.providerKind);
    this.declareStack(input.stack);
    const key = operationKey(input.stack, kind, input.direction, input.outcome);
    this.messages.set(key, (this.messages.get(key) || 0) + 1);
    if (
      input.outcome === "attempt"
      || input.latencyMs === undefined
      || !Number.isFinite(input.latencyMs)
    ) return;
    const value = Math.max(0, input.latencyMs);
    const histogram = this.latencies.get(key) || createHistogram();
    observeHistogram(histogram, value);
    this.latencies.set(key, histogram);
  }

  reset(): void {
    this.stacks.clear();
    this.bindings.clear();
    this.messages.clear();
    this.latencies.clear();
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP open_cowork_channel_stack_info Presence marker for a deployed channel telemetry stack.",
      "# TYPE open_cowork_channel_stack_info gauge",
      ...[...this.stacks].sort().map((stack) =>
        `open_cowork_channel_stack_info${labels({
          surface: this.surface,
          stack,
          schema_version: CHANNEL_STACK_TELEMETRY_SCHEMA_VERSION,
        })} 1`),
      "# HELP open_cowork_channel_bindings Channel bindings by configured or active status.",
      "# TYPE open_cowork_channel_bindings gauge",
      ...renderMap(this.bindings, (key, value) => {
        const [stack, providerKind, status] = key.split("\u001f");
        return `open_cowork_channel_bindings${labels({
          surface: this.surface,
          stack,
          provider_kind: providerKind,
          status,
        })} ${value}`;
      }),
      "# HELP open_cowork_channel_messages_total Channel operations by direction and bounded outcome.",
      "# TYPE open_cowork_channel_messages_total counter",
      ...renderMap(this.messages, (key, value) => {
        const [stack, providerKind, direction, outcome] = key.split("\u001f");
        return `open_cowork_channel_messages_total${labels({
          surface: this.surface,
          stack,
          schema_version: CHANNEL_STACK_TELEMETRY_SCHEMA_VERSION,
          provider_kind: providerKind,
          direction,
          outcome,
        })} ${value}`;
      }),
      "# HELP open_cowork_channel_operation_latency_ms Composition-boundary latency in milliseconds for terminal outcomes.",
      "# TYPE open_cowork_channel_operation_latency_ms histogram",
      ...renderMap(this.latencies, (key, histogram) => {
        const [stack, providerKind, direction, outcome] = key.split("\u001f");
        return renderHistogram(histogram, {
          surface: this.surface,
          stack,
          schema_version: CHANNEL_STACK_TELEMETRY_SCHEMA_VERSION,
          provider_kind: providerKind,
          direction,
          outcome,
        });
      }).flat(),
    ];
    return `${lines.join("\n")}\n`;
  }
}

export function boundedProviderKind(value: unknown): ChannelProviderKind | "other" {
  if (isChannelProviderKind(value)) return value;
  return channelProviderKindFromId(value) || "other";
}

function bindingKey(
  stack: ChannelTelemetryStack,
  providerKind: ChannelProviderKind | "other",
  status: ChannelTelemetryBindingStatus,
): string {
  return [stack, providerKind, status].join("\u001f");
}

function operationKey(
  stack: ChannelTelemetryStack,
  providerKind: ChannelProviderKind | "other",
  direction: ChannelTelemetryDirection,
  outcome: ChannelTelemetryOutcome,
): string {
  return [stack, providerKind, direction, outcome].join("\u001f");
}

function createHistogram(): Histogram {
  return { counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 };
}

function observeHistogram(histogram: Histogram, value: number): void {
  let index = LATENCY_BUCKETS_MS.findIndex((boundary) => value <= boundary);
  if (index < 0) index = LATENCY_BUCKETS_MS.length;
  histogram.counts[index] = (histogram.counts[index] || 0) + 1;
  histogram.sum += value;
  histogram.count += 1;
}

function renderHistogram(histogram: Histogram, baseLabels: Record<string, string | undefined>): string[] {
  let cumulative = 0;
  const lines = LATENCY_BUCKETS_MS.map((boundary, index) => {
    cumulative += histogram.counts[index] || 0;
    return `open_cowork_channel_operation_latency_ms_bucket${labels({
      ...baseLabels,
      le: String(boundary),
    })} ${cumulative}`;
  });
  cumulative += histogram.counts[LATENCY_BUCKETS_MS.length] || 0;
  lines.push(`open_cowork_channel_operation_latency_ms_bucket${labels({
    ...baseLabels,
    le: "+Inf",
  })} ${cumulative}`);
  lines.push(`open_cowork_channel_operation_latency_ms_sum${labels(baseLabels)} ${histogram.sum}`);
  lines.push(`open_cowork_channel_operation_latency_ms_count${labels(baseLabels)} ${histogram.count}`);
  return lines;
}

function renderMap<T>(map: Map<string, T>, render: (key: string, value: T) => string | string[]): Array<string | string[]> {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => render(key, value));
}

function labels(values: Record<string, string | undefined>): string {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
