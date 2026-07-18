# Dogfood Case Study: 25 Days of Real Use

This is a real usage record, not a scenario. It captures what a single
operator's live OpenCode Gateway instance looked like after ~25 days of genuine
delegated work (2026-06-13 → 2026-07-08), and what the roadmap improvements in
[#200](https://github.com/joe-broadhead/opencode-gateway/issues/200) surfaced
about it. All numbers below are read directly, read-only, from the operator's
durable store — no work was dispatched or mutated to produce this document.

## The instance

- **Uptime:** the daemon had been running continuously for ~9 days at capture
  time; the store spans ~25 days of activity.
- **Work:** 7 Initiatives, 19 Issues (all `done`), 156 agent runs.
- **Spend:** $2.10 total, ~99.6M tokens, across ~18 OpenCode sessions.
- **Durable store:** a 270 MB `gateway.db` with ~13,400 workflow events and
  **~305,000 hash-chained audit-ledger rows** (the store was live and still
  growing at capture time).

## What the run history actually looked like

| Outcome | Runs |
| --- | --- |
| passed | 55 |
| errored | 86 |
| failed | 15 |

**55% of all runs errored.** Before the analytics work, that fact was invisible
without hand-writing SQL against the store. It is the single most important
thing an operator would want to know, and it was not surfaced anywhere.

## What the scorecard surfaced (issue #193)

Running the run-history scorecard over the real data immediately localises the
problem to one profile:

| Profile | Runs | Passed | Errored | Failed | Completion | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| implementer | 105 | 25 | 79 | 1 | **24%** | **$1.96** |
| reviewer | 32 | 14 | 6 | 12 | 44% | $0 |
| verifier | 16 | 15 | 0 | 1 | **94%** | $0 |
| auditor | 3 | 1 | 1 | 1 | 33% | $0.14 |

At first read the story tells itself: **the `implementer` profile completes only
24% of its runs, errors on 79 of 105, and consumes 94% of the entire budget.**
The `verifier` profile, by contrast, is healthy at 94%. `reviewer`'s "failures"
are mostly legitimate review rejections (`failed`, not `errored`). Without the
scorecard, the operator sees only a flat "$2.10 spent, 19 tasks done" and has no
way to know that almost all of the spend and nearly all of the errors come from
one profile.

### Correcting the "24% completion" framing (issue #202)

That first read is misleading, and #202 forced the honest root cause. Classifying
the `implementer`'s **79 errored runs by their `result_json` cause** — not just
counting them — tells a very different story:

| Error class | Cohort | Runs |
| --- | --- | --- |
| `recovered_session` (OpenCode session vanished; orphan-recovery marked the run errored) | operational | **69** |
| `force_done` (task marked done externally while running) | operational | 7 |
| `lease_expired` (expired scheduler lease recovered) | operational | 1 |
| `provider_balance` (`HTTP 402: [DeepSeek] Insufficient Balance`) | external | 1 |
| `transport` (`fetch failed`) | external | 1 |
| `genuine_failure` (real implement/prompt failure) | genuine | **0** |

**Zero of the 79 errored runs are genuine implement failures.** The
overwhelming majority — 77 of 79 — are *operational*: Gateway's own run-lifecycle
churn (69 session recovery, 7 force-done, 1 lease expiry), not the profile's
fault. The remaining 2 are *external* (a provider-balance blip and one transport
hiccup), outside the profile prompt's control. The "24% completion" headline is
therefore an artifact of counting every errored run identically: the analytics
now expose a **`genuineFailureRate`** that charges only the genuine cohort
against terminal runs, so the `implementer`'s real profile-fault failure rate is
**0% (0/105)**, not 76%. (These are the exact counts `gateway analytics
--scorecard` reports over the store; the classifier keys on the durable
`result_json` cause text.)

**The `implementer` profile prompt is not the problem.** With `genuineFailureRate`
at 0%, the actionable insights are (a) session lifecycle for long-running
implementer runs — the recovered-session churn is where the real leverage is —
and (b) watching provider balance.
The scorecard, CLI (`analytics --scorecard`), `gateway_analytics_scorecard` MCP
tool, and the dashboard analytics view now all surface this operational-vs-
genuine split, so an operator sees *why* runs error, not just how many.

**Retry hotspots** told the same story from another angle — one task had
ballooned to **81 runs** (max attempt 3), and another to 8 runs (max attempt 4):

| Task | Runs | Max attempt |
| --- | --- | --- |
| `task_5b86ef59…` | 81 | 3 |
| `task_25050575…` | 8 | 4 |
| `task_ae01129e…` | 7 | 3 |

A single Issue quietly consuming 81 runs is exactly the kind of runaway the
retry-hotspot view is meant to catch, and it accounts for a large share of the
`implementer` error count.

## Friction found (the honest part)

Real use surfaced concrete problems, not just wins:

1. **Cross-build upgrade is a hard stop.** The running daemon (an older build)
   reported a **critical storage schema-consistency failure**: *"Gateway storage
   has critical consistency failures. Upgrade Gateway to a build that supports
   this schema before starting the daemon."* This validates the #197 decision to
   drop cross-version migration for this single-operator tool — but the operator
   experience is a blocking failure with a message that implies a migrating
   build exists. A fresh-repo tool that expects "recreate the DB on a schema
   change" must **say that plainly** rather than pointing at a non-existent
   upgrade path.
2. **The `implementer` profile shows 24% raw completion** and is where 94% of
   spend goes — but classifying its 79 errored runs (issue #202) shows this is
   **overwhelmingly operational, not a broken prompt**: 77 of 79 are Gateway
   run-lifecycle churn (69 session-recovery, 7 force-done, 1 lease-expired), 2
   are external (1 provider-balance 402, 1 transport), and **0 are genuine
   implement failures** (`genuineFailureRate` 0%). The real leverage is session
   lifecycle for long implementer runs plus watching provider balance — not the
   profile prompt. Gateway now makes both the raw rate and the
   genuine-vs-operational split impossible to miss (scorecard error-class
   breakdown + `genuineFailureRate`).
3. **A task reached 81 runs.** Whatever retry/stuck-task guard exists did not
   stop one Issue from consuming 81 runs. This is a candidate for a per-task run
   cap or a stuck-task alert.
4. **The store is 270 MB with 305k audit-ledger rows** after 25 days. Retention
   is working (the ledger is chunk-pruned with a hash-chain anchor), but the
   absolute size and row count on a modest workload confirm that append-forever
   surfaces need active retention, and that the windowed hot-path reads added in
   this cycle matter for a store this size.
5. **Health showed `down` (2 degraded, 1 down) and SLO `warn`** on a
   long-running instance — the observability layer is doing its job, and the
   operator would benefit from the proactive alerts and the interactive
   dashboard drill-down added in #196 to reach root cause.

## What this validates

- **Analytics (#193) is the highest-leverage feature in the roadmap.** On the
  very first real dataset it turned an invisible "55% error rate, one profile
  eating the budget, one task at 81 runs" into three specific, actionable facts.
- **The interactive dashboard (#196)** is where those facts become
  drill-down-able (profile → its runs → the erroring run's result).
- **The tightened onboarding/doctor (#195)** behaved correctly live: `doctor`
  refused with an actionable "run setup" message, and `setup --yes` provisioned
  the config, the state DB, the OpenCode MCP + agents/skills, and the local admin
  token in one non-interactive step.
- **Stripping migration machinery (#197)** is the right call for this tool — but
  the cross-build failure message needs to teach "recreate", not "upgrade".

## Prioritized follow-ups

These are captured as issues off the back of this dogfood:

1. **Investigate the `implementer` profile** (24% raw completion, 94% of spend).
   ✅ Done via #202's diagnostic error-class breakdown: 77 of 79 errors are
   operational (session-recovery churn) and 2 are external (one provider-balance
   402, one transport), with **zero genuine failures** (`genuineFailureRate`
   0%) — the prompt is not the problem; session lifecycle and provider balance
   are. #205 adds a proactive alert on the derived `genuineFailureRate` so a
   truly degrading profile surfaces without crying wolf on operational churn.
   ([#202](https://github.com/joe-broadhead/opencode-gateway/issues/202),
   [#205](https://github.com/joe-broadhead/opencode-gateway/issues/205))
2. **Per-task run cap / stuck-task alert** — nothing should reach 81 runs
   silently.
   ([#203](https://github.com/joe-broadhead/opencode-gateway/issues/203))
3. **Clear "recreate your database" guidance** on a cross-build schema mismatch,
   replacing the stale "upgrade to a supporting build" message.
   ([#204](https://github.com/joe-broadhead/opencode-gateway/issues/204))
4. **Surface the scorecard proactively** — e.g. an alert when a profile's
   completion rate drops below a threshold over a window, so the operator does
   not have to look.
   ([#205](https://github.com/joe-broadhead/opencode-gateway/issues/205))
