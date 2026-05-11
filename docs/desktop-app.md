# Desktop App Guide

## Main sections

The desktop app is centered around eight areas:
- `Home` — welcoming landing surface
- `Chat` — where OpenCode sessions run
- `Threads` — searchable history, metadata facets, user tags, and saved filters
- `Automations` — the durable schedule / inbox / run control plane
- `Crews` — supervised multi-agent runs with trace, queue, and eval visibility
- `Agents` — manage built-in and custom agents
- `Capabilities` — browse tools, skills, and MCPs
- `Pulse` — diagnostic workspace dashboard

```mermaid
flowchart TD
    Home["Home<br/>composer · recent threads · @-agent pills"]
    Chat["Chat<br/>session UI · streamed events · approvals"]
    Threads["Threads<br/>search · facets · tags · filters"]
    Auto["Automations<br/>list · inbox · work items · runs · deliveries"]
    Crews["Crews<br/>lead · specialists · evaluator · queue"]
    Agents["Agents<br/>built-in + custom"]
    Caps["Capabilities<br/>tools · skills · MCPs"]
    Pulse["Pulse<br/>runtime · usage · perf · inventory"]
    Settings["Settings<br/>appearance · models · permissions · channels · storage"]

    Home -->|submit prompt| Chat
    Home -->|history search| Threads
    Home -->|status strip| Pulse
    Threads -->|open result| Chat
    Chat -->|@agent| Agents
    Chat -->|tool calls| Caps
    Auto -->|run links| Chat
    Crews -->|root sessions| Chat
    Pulse -->|capability counts| Caps
    Pulse -->|agent inventory| Agents
    Pulse -.linked from sidebar.-> Settings
```

Home is the landing surface; submitting a prompt routes to Chat in one
motion. Threads is the full-history workspace for search, facets, tags,
and saved filters. Pulse, Capabilities, Agents, Crews, and Automations each present a
dedicated operational surface; Settings holds appearance, models,
permissions, channel pairing, and storage.

## Home

![Home composer with greeting, @-agent suggestion pills, and the runtime status strip](assets/auto/home.png)

Home is the app's welcoming landing surface. It opens with a single ask
so business users aren't greeted by a wall of diagnostics on first
launch:

- a friendly greeting ("What shall we cowork on today?")
- a composer with drag-and-drop file attachment and paste-to-attach
  for screenshots
- @-agent suggestion pills that pre-fill the composer with a mention
- up to three recent-thread cards to jump back into prior work
- a quiet status strip that links to Pulse when users want the
  diagnostic view

Submitting from the Home composer creates and activates a new session,
routes the view to Chat, and fires the first prompt in a single motion.

## Pulse

![Pulse dashboard showing runtime, provider, capabilities, agents, usage, and performance cards](assets/auto/pulse.png)

Pulse is the workspace-at-a-glance surface. It's one click away in the
sidebar and is where the runtime / health / usage / agent telemetry
that used to live on Home now lives.

Pulse mixes:
- runtime health and provider / model status
- capability inventory (tools, skills, MCP connections)
- agent inventory (built-ins + enabled custom agents)
- usage summaries — history-backed, with time ranges:
  - last 7 days
  - last 30 days
  - year to date
  - all time
- agent cost + token breakdowns
- operational queue visibility: running/queued work, queue alerts, filesystem
  and external-system authority, queue caps, serialization keys, and high-risk
  capability metadata
- channel ingress and delivery visibility: active channels, local webhook
  receiver state, recent inbound items, denied inputs, approve/dismiss actions
  for channel-routed SOP or Crew work, and reviewed delivery drafts
- governed learning diagnostics for proposed memories, improvement proposals,
  dream runs, policy blocks, and review actions in the Improvement Inbox
- recent performance metrics

Power users and downstream evaluators can pin this page; it's the
fastest way to see the state of every moving part of the workspace.

## Chat

![Chat thread with the @-mention picker open over the list of available sub-agents](assets/auto/chat-mention-picker.png)

Chat is where OpenCode sessions run.

Important behavior:
- `@agent` selects a target agent for the prompt
- skills are OpenCode-native and are not invoked through a custom `$skill` syntax
- streamed text, tool calls, approvals, and task runs are projected into a UI-safe session model

## Threads

Threads is the full-history workspace. The sidebar list remains the
fast recent-thread switcher, while the Threads page provides indexed
search, cursor-loaded results, metadata facets, user tags, smart
filters, and suggestion chips.

The page distinguishes actual metadata from suggestions. Actual badges
come from session evidence such as provider/model, observed agents, and
observed tools. Suggestions are local categorization hints that users
can accept, edit, dismiss, or ignore; they never become tags unless a
user explicitly applies one.

Tags are keyboard accessible through row checkboxes plus Apply/Remove
buttons. Dragging selected rows onto a tag is only a progressive
enhancement.

## Automations

![Automations overview with templates, draft form, and recent activity](assets/auto/automations-overview.png)

Automations are the durable product layer for always-on work.

They keep the runtime split clean:
- OpenCode still executes `plan`, `build`, subagents, approvals, questions, and tools
- Open Cowork adds the durable scheduling, inbox, work-item, retry, and delivery surfaces around that execution

The current upstream surface includes:
- recurring schedules (`one_time`, `daily`, `weekly`, `monthly`)
- review-first enrichment before execution
- heartbeat supervision for due or blocked work
- inbox items for clarification, approval, and failure handling
- durable work items, runs, and in-app deliveries
- operations queue authority for automation and SOP-backed execution runs,
  including serialized project-scoped writes and visible queue caps
- optional preferred specialists that bias routing without replacing the `plan` / `build` flow

Once an automation exists it gets a dedicated detail surface for
brief, run timeline, reliability, and run policy:

![Automation detail with execution brief, run timeline, reliability, and run policy panels](assets/auto/automations-detail.png)

## Crews

Crews are supervised multi-agent product runs. A crew version defines a lead,
specialists, an evaluator, a workspace profile, and an optional budget cap.
When a crew run starts, Open Cowork records the durable product run, enters it
into the operations queue, and only then dispatches the lead through OpenCode.

That queue integration keeps the runtime boundary intact:
- OpenCode still owns sessions, task delegation, tools, questions, approvals,
  and streamed events.
- Open Cowork owns run metadata, queue state, authority visibility, trace
  records, evaluator handoff, and cost/budget diagnostics.

Write-capable crew runs targeting the same crew, lead-agent, or external-system authority wait in
the durable queue instead of dispatching concurrently. When an evaluator passes
a run, the queue item is completed and the next compatible queued crew can
dispatch. Pulse shows the queue item, effective autonomy, filesystem/external
authority, duration/cost caps, and any stuck or blocked alerts.

## Project vs sandbox threads

### Project thread

A project thread is bound to a real directory and is appropriate for:
- code generation
- file editing
- repository work

### Sandbox thread

A sandbox thread uses a private Cowork-managed workspace and surfaces outputs as artifacts.

This is appropriate for:
- generated reports
- drafts
- charts
- private experimentation

## Artifacts

Sandbox-generated files are treated as artifacts first.

Artifact actions include:
- save as
- reveal in Finder/file manager
- storage cleanup from Settings

## Agents

![Agents page listing built-in and custom agents in a portrait card grid](assets/auto/agents.png)

The Agents page lets users:
- inspect built-in agents
- create custom agents
- bind custom agents to specific tools and skills

Custom agents compile into OpenCode-native agent configuration rather than a parallel Open Cowork execution system.

Clicking a card opens the builder, which shows the same skills, tools,
instructions, and inference panels for both built-in and custom agents:

![Agent builder showing the build agent with skills, tools, and inference settings](assets/auto/agents-builder-detail.png)

## Capabilities

![Capabilities page on the Tools tab showing built-in and installed MCP tools with method counts](assets/auto/capabilities-tools.png)

The Capabilities page lets users inspect:
- built-in tools
- custom tools from MCPs
- bundled skills
- custom skills

This page is the main visibility surface for the tool and skill catalog.

Selecting a tool drills into a detail view that lists the resolved
methods, the source scope, and the option to spin up an agent bound
to that tool:

![Capabilities tool detail page showing methods and source for the bash tool](assets/auto/capabilities-tool-detail.png)

## Settings

![Settings panel on the Appearance tab with theme presets and color scheme picker](assets/auto/settings-appearance.png)

Settings currently cover:
- appearance — built-in theme presets, including Matrix, plus color scheme and fonts
- models — provider, model, and credentials
- automations — schedule, notifications, defaults, governed learning policy,
  and operations guardrails for autonomy, queue parallelism, budget, duration,
  and retry ceilings
- permissions — local tool access (bash, file write) and the developer
  config bridge into the managed OpenCode runtime
- channels — local webhook receiver status, paired source keys, sender
  allowlists, activation routes, and one-time token rotation
- storage — sandbox artifacts and cleanup

The Models tab is where providers and credentials are managed, and is
typically the first stop on a fresh install:

![Settings panel on the Models tab showing provider list and credential editor](assets/auto/settings-models.png)

The Storage section reports sandbox usage and provides cleanup
controls for old or unused sandbox workspaces.

The Channels section creates local webhook pairings against channel-bound
workspace profiles. Each pairing records a source key, sender allowlist,
activation mode, optional SOP or Crew route, and optional capability scope.
Pairing tokens are only revealed when created or rotated.

Channel items configured for `run_sop` or `run_crew` still stop at Pulse for
human review. Approving the item hands it to the existing SOP or Crew service
and links the resulting run back to the inbound audit record; dismissing it
cancels the review queue entry without triggering OpenCode execution.

When linked SOP or Crew work completes, Pulse can project the run output into a
channel delivery draft. The draft keeps the work-item/run link plus any recorded
artifacts, approvals, policy decisions, and evaluator results so the outbox is
auditable without hydrating the full OpenCode transcript.

Delivery drafts are reviewed from Pulse. Webhook drafts can be sent only after
an explicit user action, and the target must pass the same public-network policy
used for HTTP MCP endpoints plus an HTTPS-only check. Slack, email, and Teams
records remain draft-only until a real provider integration is configured.
