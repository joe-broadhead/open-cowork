import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelStackTelemetry,
  boundedProviderKind,
} from "@open-cowork/gateway-channel";

test("channel stack telemetry exposes bounded parity metrics and real zeroes", () => {
  const telemetry = new ChannelStackTelemetry("standalone-gateway", ["monorepo-provider"]);
  telemetry.setBindingCount("monorepo-provider", "telegram-customer-instance", "configured", 2);
  telemetry.setBindingCount("monorepo-provider", "telegram", "active", 1);
  telemetry.recordOperation({
    stack: "monorepo-provider",
    providerKind: "telegram-customer-instance",
    direction: "inbound",
    outcome: "attempt",
  });
  telemetry.recordOperation({
    stack: "monorepo-provider",
    providerKind: "telegram-customer-instance",
    direction: "outbound",
    outcome: "success",
    latencyMs: 42,
  });

  const text = telemetry.renderPrometheus();
  assert.match(text, /open_cowork_channel_stack_info\{schema_version="2",stack="monorepo-provider",surface="standalone-gateway"\} 1/);
  assert.match(text, /open_cowork_channel_bindings\{provider_kind="telegram",stack="monorepo-provider",status="configured",surface="standalone-gateway"\} 2/);
  assert.match(text, /direction="outbound",outcome="retry".*\} 0/);
  assert.match(text, /open_cowork_channel_operation_latency_ms_count\{direction="outbound",outcome="success",provider_kind="telegram",schema_version="2"/);
});

test("channel stack telemetry never renders ids, tenant data, content, or secrets as labels", () => {
  const telemetry = new ChannelStackTelemetry("durable-gateway");
  telemetry.setBindingCount("durable-native", "custom-secret-provider", "configured", 1);
  telemetry.recordOperation({
    stack: "durable-native",
    providerKind: "tenant-123-secret",
    direction: "outbound",
    outcome: "error",
    latencyMs: 12,
  });
  const text = telemetry.renderPrometheus();
  assert.equal(boundedProviderKind("custom-secret-provider"), "other");
  assert.doesNotMatch(text, /custom-secret-provider|tenant-123-secret|provider_id|tenant|binding_id|content|secret=/);

  const labelNames = new Set(
    [...text.matchAll(/([a-z_]+)="/g)].map((match) => match[1]),
  );
  assert.deepEqual(
    [...labelNames].sort(),
    ["direction", "le", "outcome", "provider_kind", "schema_version", "stack", "status", "surface"],
  );
});

test("an undeployed stack is absent while a deployed unused stack reports zero", () => {
  const absent = new ChannelStackTelemetry("cloud-channel-gateway").renderPrometheus();
  assert.doesNotMatch(absent, /open_cowork_channel_stack_info\{/);

  const present = new ChannelStackTelemetry("cloud-channel-gateway", ["monorepo-provider"]);
  present.setBindingCount("monorepo-provider", "signal", "configured", 0);
  const rendered = present.renderPrometheus();
  assert.match(rendered, /open_cowork_channel_stack_info\{/);
  assert.match(rendered, /direction="outbound",outcome="success",provider_kind="signal".*\} 0/);
});

test("latency covers terminal inbound and outbound composition operations", () => {
  const telemetry = new ChannelStackTelemetry("cloud-channel-gateway", ["monorepo-provider"]);
  for (const operation of [
    { direction: "inbound", outcome: "success" },
    { direction: "outbound", outcome: "ignored" },
  ] as const) {
    telemetry.recordOperation({
      stack: "monorepo-provider",
      providerKind: "telegram",
      ...operation,
      latencyMs: 42,
    });
  }

  const rendered = telemetry.renderPrometheus();
  assert.match(
    rendered,
    /open_cowork_channel_operation_latency_ms_count\{direction="inbound",outcome="success",provider_kind="telegram",schema_version="2",stack="monorepo-provider",surface="cloud-channel-gateway"\} 1/,
  );
  assert.match(
    rendered,
    /open_cowork_channel_operation_latency_ms_count\{direction="outbound",outcome="ignored",provider_kind="telegram",schema_version="2",stack="monorepo-provider",surface="cloud-channel-gateway"\} 1/,
  );
});

test("reset clears process-local telemetry until the stack is explicitly declared again", () => {
  const telemetry = new ChannelStackTelemetry("standalone-gateway", ["monorepo-provider"]);
  telemetry.setBindingCount("monorepo-provider", "telegram", "configured", 1);
  telemetry.recordOperation({
    stack: "monorepo-provider",
    providerKind: "telegram",
    direction: "inbound",
    outcome: "success",
    latencyMs: 12,
  });

  const before = telemetry.renderPrometheus();
  assert.match(before, /open_cowork_channel_stack_info\{/);
  assert.match(before, /open_cowork_channel_bindings\{/);
  assert.match(before, /open_cowork_channel_messages_total\{/);
  assert.match(before, /open_cowork_channel_operation_latency_ms_count\{/);

  telemetry.reset();

  const reset = telemetry.renderPrometheus();
  assert.doesNotMatch(reset, /open_cowork_channel_stack_info\{/);
  assert.doesNotMatch(reset, /open_cowork_channel_bindings\{/);
  assert.doesNotMatch(reset, /open_cowork_channel_messages_total\{/);
  assert.doesNotMatch(reset, /open_cowork_channel_operation_latency_ms_count\{/);

  telemetry.declareStack("monorepo-provider");
  assert.match(
    telemetry.renderPrometheus(),
    /open_cowork_channel_stack_info\{schema_version="2",stack="monorepo-provider",surface="standalone-gateway"\} 1/,
  );
});
