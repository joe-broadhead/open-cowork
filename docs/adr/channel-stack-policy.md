---
title: ADR — Time-bounded two-stack channel policy
description: Evidence, ownership, and removal triggers for Open Cowork's channel protocol stacks.
---

# ADR: Time-bounded two-stack channel policy

| Field | Value |
| --- | --- |
| Status | **Accepted — temporary two-stack exception** |
| Decision date | 2026-07-29 |
| Owner | Gateway & Channels maintainers |
| Mandatory review | 2026-10-31, or earlier when a reopening trigger fires |
| Linear | JOE-1187, JOE-1211, [JOE-1456](https://linear.app/joe-broadhead/issue/JOE-1456/p2-review-the-time-bounded-two-stack-channel-exception-with) |
| Telemetry | [Channel stack telemetry](../channel-stack-telemetry.md) |

## Decision

Retain both protocol stacks for one bounded evidence window. This is not a
permanent freeze and it is not evidence that both implementations have equal
value. Convergence is unsafe today because the stacks have independent released
consumers and do not yet have equivalent provider semantics. JOE-1213 is
therefore unnecessary for this decision and must not delete either stack.

The next review must observe at least 30 consecutive representative production
days after a release containing telemetry schema version 1. It must then choose
a convergence migration or renew this exception once with new evidence,
ownership, triggers, and an expiry. An incomplete scrape window cannot be
interpreted as low use.

## Evidence available at decision time

### Production evidence

There is no representative released observation window for both stacks. Before
JOE-1187, the products exposed different metrics and did not distinguish
configured inventory from successful use. This ADR therefore makes no claim
about relative production adoption, reliability, or latency.

JOE-1187 introduces common configured/active binding, attempt, terminal outcome,
and outbound egress-request latency metrics on the existing Prometheus surfaces.
Inbound latency is intentionally excluded because the three surfaces do not
share a comparable inbound completion boundary. The missing window is a
limitation of this decision, not a zero-valued result. JOE-1456 owns the
mandatory evidence review.

### Architecture and consumer evidence

| Consumer or commitment | Current dependency | Removal constraint |
| --- | --- | --- |
| Cloud Channel Gateway OCI image and Helm/appliance assets | Monorepo `gateway-provider-*` stack | Cloud delivery and provider readiness are composed directly from these packages. |
| Standalone Gateway source appliance | Monorepo provider stack | Owns private OpenCode execution and registers Telegram/webhook providers directly. |
| Durable `cowork-gateway` product and independent release line | Durable native adapters by default | Existing Telegram, Discord, and WhatsApp configuration defaults and native endpoints are compatibility commitments. |
| Durable standalone tarball | Durable product plus vendored monorepo provider packages | Opt-in `protocolStack: monorepo` is packaged for rollback/canary, so both package families are release inputs. |
| Frozen private Gateway repository | Last frozen build only | It is read-only compatibility history, not a place to dual-develop new fixes. |

The monorepo stack also supports provider kinds not implemented as Durable
native adapters. Conversely, Durable Discord and WhatsApp accept their native
platform protocols, while the corresponding monorepo providers are signed
relay bridges. Deleting native adapters now would require new relay
infrastructure and would silently change operator-facing endpoints.

The current façade compatibility limits are removal constraints, not evidence
that the native stack is redundant:

- Telegram's monorepo path uses the grammy poll offset rather than the Durable
  HA operational-sidecar cursor, degrades rich HTML `sendRichMessage` output to
  text, and does not mirror native `setMyCommands` registration.
- Discord and WhatsApp use bridge relays rather than native Graph or
  Interactions endpoints. The relay must verify the native platform signature,
  and structured rich outbound payloads degrade to text on the bridge path.

At this decision, production channel source is approximately 3,644 lines under
`products/gateway/src/channels` and 5,453 lines across
`packages/gateway-channel` and `packages/gateway-provider-*`. These counts are
maintenance indicators, not interchangeable feature totals.

## Quantitative review and removal triggers

The scheduled review evaluates the dashboard queries in
`channel-stack-telemetry.md` over the same released interval, selects a Grafana
range of at least 30 consecutive representative days, and preserves
`provider_kind` in every comparison. A Durable-native decommission plan is
unblocked only when all of these are true:

1. For every overlapping provider, the monorepo path carries at least 95% of
   successful Durable Gateway operations or the native path carries less than
   5% of successful operations and active bindings.
2. For every overlapping provider, the monorepo terminal error ratio is no more
   than 0.5 percentage points worse than native, and its successful outbound
   egress-request p95 is no more than 1.2 times native p95. Retry and error
   ratios are reviewed independently.
3. Provider capability, ingress authentication, delivery, HA cursor,
   packaging, configuration migration, and rollback parity have no unresolved
   production-critical gap.
4. Cloud Channel Gateway, Standalone Gateway, Durable Gateway, and independent
   package consumers have a reviewed compatibility plan.

If the evidence instead favors Durable native as the convergence target, a new
plan must first prove that Cloud Channel Gateway and Standalone Gateway can
compose it without importing a second execution runtime or losing their
provider coverage. Current architecture does not meet that condition.

The owner must review immediately, without waiting for the date, after any of:

- a critical channel security defect requires different fixes in both stacks;
- a third same-protocol dual fix lands within one quarter;
- a stack cannot meet a supported deployment or packaging contract;
- telemetry shows a stack below the 5% successful-use and active-binding
  thresholds for 30 representative days.

## Product, architecture, operations, and security review

| Review | Recorded conclusion |
| --- | --- |
| Product | Do not remove native platform endpoints or provider coverage without a migration promise. |
| Architecture | Keep OpenCode as the sole execution owner; this decision concerns channel adapters only. |
| Operations | Use existing Prometheus collection, treat absent series as unknown, and retain rollback selectors through the evidence window. |
| Security | Shared verification kernels and the dual-stack PR checklist remain mandatory; bridge-mode security warnings remain visible. |

## Consequences

- Both stacks earn a temporary place because removing either currently breaks a
  released consumer or protocol contract.
- Common telemetry and a dated review replace the previous indefinite freeze.
- Thin Discord, WhatsApp, and Signal bridge wrappers may share construction
  code because the retained monorepo stack has independent consumers.
- Native-stack decommission work is canceled for this decision. It can only be
  reopened by the evidence review or an immediate trigger above.
