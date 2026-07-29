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
| `open_cowork_channel_messages_total` | counter | `surface`, `stack`, `schema_version`, `provider_kind`, `direction`, `outcome` | Inbound/outbound attempts and mutually exclusive terminal `success`, `retry`, `error`, or `ignored` outcomes. |
| `open_cowork_channel_operation_latency_ms` | histogram | message labels plus `le` | Composition-boundary latency for terminal inbound and outbound outcomes. Quantiles must be calculated from `_bucket`. |

`surface` is one of `cloud-channel-gateway`, `standalone-gateway`, or
`durable-gateway`. `stack` is `monorepo-provider` or `durable-native`.
`provider_kind` is normalized to the finite provider-kind contract; unknown
values become `other`. The schema version is currently `2`.

The version label is carried on the operation counter and latency histogram,
not only the presence gauge. Evidence queries must pin
`schema_version="2"` so a rollout window cannot combine the former classifier
semantics with the observed-outcome contract.

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

An outbound operation is one composition-level request to deliver a logical
message, acknowledgement, or rendered event. Provider-internal or
composition-owned text chunking and structured-message delegation remain part
of that one request; they never multiply attempts or latency samples.
Every operation emits exactly one `attempt` and exactly one terminal outcome.

For inbound operations, the comparable boundary starts when the composed
provider invokes the product handler and ends when that handler commits accepted
work, explicitly defers it, rejects or ignores it, or fails. `success` requires
actual accepted use: a trusted, authorized, non-empty, non-duplicate interaction,
command, or prompt was committed. Duplicate events, empty messages, trust or
authorization denials, and other intentional no-ops are `ignored`; they never
inflate adoption or reliability ratios.

For outbound operations, `success` means the complete composition request
returned successfully. `retry` is emitted only after the owning surface
concretely preserves or schedules the failed operation for another attempt,
such as persisting a retry timestamp, retaining an inbound cursor for
redelivery, or scheduling an idempotent render retry. A failure that merely
looks retryable is still `error` when no retry handoff occurred. Error text and
response bodies are never labels.

On the Durable surface, native Telegram reports `retry` only when its polling
cursor is retained, native WhatsApp only when the webhook returns non-2xx, and
the signed Discord/WhatsApp bridge paths only when handler rejection propagates
to a non-2xx bridge response. Native Discord interactions acknowledge before
asynchronous handler completion, while native Discord gateway events have no
redelivery contract; their handler failures therefore report `error`, even
when the underlying cause is transient.

On the Standalone surface, signed generic webhooks and Telegram webhook mode
report `retry` when a failed handler releases its replay claim and propagates a
non-2xx response. Telegram polling has no equivalent redelivery handoff and
therefore reports the same handler failure as `error`.

## Missing data and retention

An emitted zero means the stack is deployed and the bounded dimension has not
observed traffic since process start. An absent `stack_info` series means the
stack is not deployed, has not been scraped, or predates this contract; it is
not evidence of zero use. The dashboard checks every expected surface
independently:

```promql
absent(open_cowork_channel_stack_info{surface="cloud-channel-gateway",schema_version="2"})
absent(open_cowork_channel_stack_info{surface="standalone-gateway",schema_version="2"})
absent(open_cowork_channel_stack_info{surface="durable-gateway",schema_version="2"})
```

If any query returns `1`, exclude that surface from comparisons until v2 scrape
coverage is restored; a v1 presence series is not sufficient and must not be
treated as zero v2 traffic.

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

Terminal volume (including intentional ignores) and separate success, retry,
and error ratios over the selected Grafana evidence range:

```promql
sum(increase(open_cowork_channel_messages_total{schema_version="2",outcome=~"success|retry|error|ignored"}[$__range]))
  by (surface, stack, provider_kind, direction, outcome)

sum(increase(open_cowork_channel_messages_total{schema_version="2",outcome="success"}[$__range]))
  by (surface, stack, provider_kind, direction)
/
clamp_min(
  sum(increase(open_cowork_channel_messages_total{schema_version="2",outcome=~"success|retry|error"}[$__range]))
    by (surface, stack, provider_kind, direction),
  1
)
```

Replace `outcome="success"` in the numerator with `outcome="retry"` and
`outcome="error"` for the retry and error ratios. Keep all grouping labels so
one high-volume provider cannot hide another provider's failure rate.

p50 and p95 successful composition-operation latency for both directions:

```promql
histogram_quantile(
  0.50,
  sum by (le, surface, stack, provider_kind, direction) (
    increase(open_cowork_channel_operation_latency_ms_bucket{
      schema_version="2",
      outcome="success"
    }[$__range])
  )
)
```

Use `0.95` for p95. Inbound latency is handler-composition latency, not
provider-network or webhook transit time; outbound latency is the composed
egress request. Keeping those direction labels separate makes the boundary
comparable across stacks without pretending the two directions measure the
same work.

## Verification

The shared metric-contract tests prove bounded labels, absent-versus-zero
behavior, counters, and histograms. Each product's metrics suite sends
synthetic operations through its local telemetry seam and verifies the rendered
Prometheus output. Durable Gateway tests both native and monorepo selections
through the `ChannelAdapter` egress wrapper, including exactly one terminal
outcome for every attempt, lifecycle preservation, and privacy-safe output.
`pnpm ops:validate` verifies that the catalog, decision queries, per-surface
absence checks, and documentation stay in sync.
