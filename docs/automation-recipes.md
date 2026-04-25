---
title: Automation Recipes
description: Concrete walkthroughs for the most common Open Cowork automations — daily digests, PR triage, and scheduled reports.
---

# Automation Recipes

Worked examples for the automations control plane. Each recipe assumes
you've read [Automations](automations.md) for the underlying model and
covers a single, end-to-end use case.

<p class="subtitle">Three real automations you can build today, plus the
patterns to extend them. The goal is to show what a well-shaped automation
looks like — not to dump every option in the schema.</p>

!!! info "Where these go in the app"

    Open the **Automations** page → **New Automation**. The fields below
    map to the form. Each recipe ends with the inbox / delivery you should
    expect on a successful first run.

---

## Recipe 1 — Daily repo digest <span class="status-badge stable">battle-tested</span>

Surface a one-paragraph summary of what changed in a repository over the
last 24 hours, plus three "things worth a closer look" callouts.

**Why automations and not chat?** The signal is most useful when it
arrives at a predictable time and survives a missed day (heartbeat picks
it back up). Chat can do this once; automations make it stick.

### Configuration

| Field | Value |
|---|---|
| Title | `Daily digest — open-cowork` |
| Goal | "Summarize commits, PR activity, and issue traffic on the `open-cowork` repo over the last 24 hours. Call out three items that seem worth a closer look." |
| Schedule | `daily` at 09:00 in the user's timezone |
| Autonomy | `review-first` (default) |
| Execution mode | `build` with `plan` enrichment |
| Preferred specialists | none — `plan` will pick |
| Retry policy | bounded exponential, max 3 attempts |
| Run policy | max 1 work-run per day, 8-minute duration cap |

### Expected flow

1. Scheduler creates a run at 09:00.
2. `plan` enriches the goal into an execution brief (clarifies "what
   counts as worth a closer look", notes the repo path).
3. The brief lands in the **Inbox** for one-time review on day one. After
   approval, subsequent days reuse the same brief unless the goal changes.
4. `build` executes — calls Git tools, fetches the diff range, drafts the
   summary.
5. Successful runs create an in-app **Delivery** record visible from the
   Inbox.

### Variations

- **Multiple repos.** Duplicate the automation per repo. Resist the
  temptation to make one mega-automation; per-repo runs are easier to
  retry and review.
- **Send to Slack instead of in-app.** v0.0.0 only ships in-app delivery.
  Wire downstream delivery via the telemetry endpoint pattern in
  [Downstream Customization](downstream.md#telemetry-forwarding) — same
  shape, different consumer.

---

## Recipe 2 — PR triage to inbox <span class="status-badge stable">battle-tested</span>

Once per day, scan open PRs on the user's repo, classify them
(`needs-review`, `needs-changes`, `stalled`, `mergeable`), and queue the
ones that need human attention into the Inbox.

### Configuration

| Field | Value |
|---|---|
| Title | `PR triage — needs human attention` |
| Goal | "Look at open PRs on `<repo>`. For each, decide whether it needs human attention this cycle. If yes, post an inbox item with the PR link, the requested action, and a one-line reason." |
| Schedule | `daily` |
| Autonomy | `review-first` initially, can be relaxed to `auto-resume` once you trust the routing |
| Execution mode | `build`, `plan` enrichment |
| Preferred specialists | `code-reviewer` if you've added one |
| Retry policy | bounded exponential, max 2 attempts (avoid spamming the inbox on transient failures) |
| Run policy | max 4 work-runs per day, 5-minute duration cap |

### Pattern note: many small inbox items beats one big run

The first instinct is to make one run that emits a single "here are all
the PRs" summary. It's tempting because it's tidy. Don't.

Inbox items are individually actionable — the user can clear them
one-by-one, snooze them, or escalate them. A monolithic summary is a
dead-end the moment one PR's classification changes. The recipe above
posts one inbox item per PR-needing-attention.

### Expected flow

1. Run starts.
2. `plan` confirms the brief (rare for it to ask anything after the
   first cycle — the goal is stable).
3. `build` enumerates open PRs (Git host MCP tool).
4. For each PR that fails the "needs attention" filter, no inbox item.
5. For each PR that needs attention, one inbox item with:
    - PR title + link
    - Suggested action (`review`, `request changes`, `nudge author`)
    - One-line reason

### Variations

- **Stale-PR escalation.** Add a second automation, `weekly`, that
  re-emits stalled-PR inbox items with a louder framing.
- **Per-team triage.** Use the config's `permissions` section to scope
  which repos a given downstream user sees, then duplicate this
  automation per team.

---

## Recipe 3 — Scheduled report generation <span class="status-badge beta">recipe-pattern</span>

Generate a weekly markdown report with embedded charts and save it as a
sandbox artifact for the user to share.

### Configuration

| Field | Value |
|---|---|
| Title | `Weekly metrics report` |
| Goal | "Generate the weekly metrics report. Pull the metrics from the configured data source, render the three standard charts (signups, retention, revenue), and produce a sandbox artifact named `metrics-week-<ISO week>.md`." |
| Schedule | `weekly` on Mondays at 07:00 |
| Autonomy | `review-first` for first 4 cycles, then `auto-resume` |
| Execution mode | `build` |
| Preferred specialists | `analyst` if you have one |
| Retry policy | bounded exponential, max 3 attempts |
| Run policy | 1 work-run per week, 12-minute duration cap |

### Expected flow

1. Run starts.
2. `build` queries the data source (an MCP you've authored — see
   [Skills & MCPs](skills-and-mcps.md#authoring-an-mcp)).
3. The agent uses the bundled `chart-creator` skill + `charts` MCP to
   render charts inline.
4. The full report is written into a **sandbox thread** as a markdown
   artifact, with charts embedded as inline data URLs.
5. Delivery surfaces the artifact link in the Inbox; the user can
   `Save As…` to share.

### Why a sandbox thread, not a project thread?

A sandbox thread keeps the artifact in private, Cowork-managed storage.
That's what you want for a recurring report — no risk of accidentally
committing it to a real project, no clutter in the user's working tree.

### Variations

- **Branch the report by team.** Add a `team` parameter to the goal and
  duplicate the automation per team. Each gets its own delivery.
- **Multi-format export.** Pair this recipe with a downstream MCP that
  converts markdown → PDF / HTML and emits a second artifact.

---

## Patterns that show up across all three

- **Goal as a paragraph, not a checklist.** `plan` is better at
  enriching prose into a brief than at parsing nested bullets.
- **Start `review-first`, relax later.** Don't trust an automation
  before you've watched it succeed three or four cycles. The autonomy
  field is meant to be turned up once it's earned.
- **One automation, one outcome.** A daily digest and a daily triage
  pass should be two automations, even if they share a data source.
  Failure isolation is worth the duplication.
- **Bound the runtime.** Duration caps keep a hung MCP from holding the
  scheduler hostage. The defaults are fine; the cap exists so you can
  tighten it for a specific automation that should never take long.
- **Heartbeat is your friend.** A missed run isn't lost — heartbeat
  surfaces it on the next cycle. You don't need to over-engineer
  "guaranteed delivery" on top of the scheduler.

## Read next

- [Automations](automations.md) — the underlying control plane.
- [Skills & MCPs](skills-and-mcps.md) — how to add the tools and skills
  these recipes lean on.
- [Configuration](configuration.md) — the schema for declaring
  automations in a downstream config.
