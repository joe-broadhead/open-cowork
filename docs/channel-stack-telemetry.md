---
title: Channel stack telemetry
description: Comparable, privacy-safe operational metrics for the channel protocol stacks.
---

# Channel stack telemetry

Open Cowork exposes one Prometheus contract for the monorepo provider stack and
the Durable Gateway native stack. It reuses each product's existing `/metrics`
surface; it does not add an analytics service or transmit telemetry by itself.

## Data dictionary

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `open_cowork_channel_stack_info` | gauge | `surface`, `stack`, `schema_version` | Presence of a deployed stack that implements this contract. |
| `open_cowork_channel_bindings` | gauge | `surface`, `stack`, `provider_kind`, `status` | Binding inventory, where `status` is `configured` or `active`. |
| `open_cowork_channel_messages_total` | counter | `surface`, `stack`, `provider_kind`, `direction`, `outcome` | Inbound/outbound attempts and mutually exclusive terminal `success`, `retry`, or `error` outcomes. |
| `open_cowork_channel_operation_latency_ms` | histogram | message labels plus `le` | Outbound egress-request latency for terminal outcomes. Quantiles must be calculated from `_bucket`; inbound operations do not emit latency samples. |

`surface` is one of `cloud-channel-gateway`, `standalone-gateway`, or
`durable-gateway`. `stack` is `monorepo-provider` or `durable-native`.
`provider_kind` is normalized to the finite provider-kind contract; unknown
values become `other`. The schema version is currently `1`.

Configured inventory is not usage. Use active bindings and successful
operations together when comparing adoption.

`active` means a configured provider has completed its local start lifecycle
and currently reports that it can accept egress. It is refreshed after
start, failed-start rollback, health/lifecycle changes, and completed stop.
It is not proof that a message was delivered; use terminal outcomes for
reliability and successful outbound operations for adoption.

The Durable daemon resolves each protocol stack when it composes its adapters.
Changing `protocolStack` requires a daemon restart; until then metrics remain
bound to the adapter that is actually running rather than the newly saved value.

An egress request is one composition-level request to deliver a logical
message, acknowledgement, or rendered event. Provider-internal or
composition-owned text chunking and structured-message delegation remain part
of that one request; they never multiply attempts or latency samples.
Every egress request emits exactly one `attempt` and exactly one terminal
outcome.
`success` means the whole request returned successfully. `retry` means the
shared bounded classifier identified a retryable provider failure (HTTP
408/409/425/429/5xx, a known network failure, or an explicitly transient
failure); it does not mean a retry was necessarily scheduled. Other provider
failures are `error`. Error text and response bodies are never labels.

## Missing data and retention

An emitted zero means the stack is deployed and the bounded dimension has not
observed traffic since process start. An absent `stack_info` series means the
stack is not deployed, has not been scraped, or predates this contract; it is
not evidence of zero use. The dashboard checks every expected surface
independently:

```promql
absent(open_cowork_channel_stack_info{surface="cloud-channel-gateway"})
absent(open_cowork_channel_stack_info{surface="standalone-gateway"})
absent(open_cowork_channel_stack_info{surface="durable-gateway"})
```

If any query returns `1`, exclude that surface from comparisons until scrape
coverage is restored; do not treat it as zero traffic.

Counters and histograms are process-local and reset on restart. Scrape interval,
storage, and retention are controlled by the operator's existing Prometheus
deployment. The repository does not persist a second telemetry copy.

## Privacy and cardinality

The contract never records prompts, message bodies, filenames, addresses,
recipient IDs, provider instance IDs, credentials, raw tenant identifiers, or
workspace identifiers. Only the bounded labels in the table above are
permitted. New labels require a privacy and cardinality review.

## Comparison queries

Configured and active bindings:

```promql
sum(open_cowork_channel_bindings) by (surface, stack, provider_kind, status)
```

Terminal volume and separate success, retry, and error ratios over the selected
Grafana evidence range:

```promql
sum(increase(open_cowork_channel_messages_total{outcome=~"success|retry|error"}[$__range]))
  by (surface, stack, provider_kind, direction, outcome)

sum(increase(open_cowork_channel_messages_total{outcome="success"}[$__range]))
  by (surface, stack, provider_kind, direction)
/
clamp_min(
  sum(increase(open_cowork_channel_messages_total{outcome=~"success|retry|error"}[$__range]))
    by (surface, stack, provider_kind, direction),
  1
)
```

Replace `outcome="success"` in the numerator with `outcome="retry"` and
`outcome="error"` for the retry and error ratios. Keep all grouping labels so
one high-volume provider cannot hide another provider's failure rate.

p50 and p95 successful outbound egress-request latency:

```promql
histogram_quantile(
  0.50,
  sum by (le, surface, stack, provider_kind) (
    increase(open_cowork_channel_operation_latency_ms_bucket{
      direction="outbound",
      outcome="success"
    }[$__range])
  )
)
```

Use `0.95` for p95. Inbound latency is deliberately absent: the three surfaces
do not share a comparable inbound completion boundary.

## Verification

The shared metric-contract tests prove bounded labels, absent-versus-zero
behavior, counters, and histograms. Each product's metrics suite sends
synthetic operations through its local telemetry seam and verifies the rendered
Prometheus output. Durable Gateway tests both native and monorepo selections
through the `ChannelAdapter` egress wrapper, including exactly one terminal
outcome for every attempt, lifecycle preservation, and privacy-safe output.
`pnpm ops:validate` verifies that the catalog, decision queries, per-surface
absence checks, and documentation stay in sync.
