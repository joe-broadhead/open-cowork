---
title: Playbooks and Workflows
description: Chat-native repeatable work in Open Cowork.
---

# Playbooks And Workflows

Playbooks are the Studio UI name for saved repeatable tasks. They are backed by
durable workflow definitions created from a normal OpenCode setup chat with the
Workflow Designer agent.

Workflows remain one noun in Open Cowork's shared
[Coordination Model](coordination-model.md). They are saved repeatable
automations. Projects and tasks coordinate multi-agent/team work, runs are
authority-scoped execution attempts, schedules trigger runs, and watches deliver
progress. A workflow may create runs, artifacts, questions, and permissions, but
it is not a separate runtime.

Workflow setup depends on the configured agent id `workflow-designer`.
Downstream builds that keep workflows enabled should keep that agent in
their app config, or intentionally update the workflow setup policy in code
and config together.

Playbooks appear across Desktop, Cloud, and Gateway deployments according to
the product mode. The release and packaging names for those modes are defined
in [Packaging and Gateway Product Modes](packaging-and-product-modes.md).

The product rule is simple:

- **OpenCode executes** sessions, agents, approvals, tools, skills, and
  streaming events.
- **Open Cowork remembers** the workflow definition, trigger schedule,
  run history, and links back to the setup/run chats. Webhook verifiers are
  retained only as ciphertext: OS-backed local ciphertext on Desktop and
  envelope-encrypted ciphertext in Cloud. They are not part of public workflow
  metadata or chat/tool transcripts.

There is no separate workflow runtime, inbox board, or hidden task engine.
Open Cowork does include a hidden built-in **Executive Assistant** agent for
workflow supervision, readiness checks, and run coordination; it is
workflow-only and is not shown in the normal chat agent picker.

`CoordinationTask` is durable product work. It is distinct from the session
`TaskRun` projection used to show OpenCode child-session delegation in chat.
Likewise, a `CoordinationProject` is a planning container and does not imply a
local project directory or host-path grant.

## How Creation Works

1. Open **Playbooks**.
2. Click **Add playbook**.
3. Open Cowork creates a normal chat with the `workflow-designer` agent.
4. You describe the repeatable task in plain language.
5. Workflow Designer asks follow-up questions until the task, tools, skills,
   coworker, and triggers are clear.
6. Workflow Designer calls the bundled `workflows_preview_workflow`
   tool and shows the proposed workflow.
7. After you explicitly confirm, Workflow Designer calls
   `workflows_create_workflow` with the preview token returned by the
   preview tool.

The saved playbook points back to that setup chat so you can reopen the
conversation that created it. A webhook created through that transcript does
not mint a credential in the tool result. Provision the first secret explicitly
from the Playbooks page, where the one-time reveal can be delivered directly to
the clipboard.

## What A Playbook Stores

A workflow stores:

- title
- repeatable instructions
- execution agent, usually `build` unless the setup chat chose another coworker
- linked skills and tools
- optional project directory
- manual, scheduled, and webhook triggers
- latest run status, summary, and linked run chat

The workflow definition is intentionally small. The detailed reasoning and
questions stay in the setup chat, where they belong.

## Triggers

Every playbook can run manually from the Playbooks page.

Scheduled triggers support:

- one-time
- daily
- weekly
- monthly

Each playbook can have at most one webhook trigger. Desktop exposes a loopback
HTTP URL. Cloud exposes
`<OPEN_COWORK_CLOUD_PUBLIC_URL>/webhooks/workflows/<workflow-id>`, derived only
from the deployment's trusted configured origin rather than request headers.
POST a JSON object to the relevant URL to start a run and pass trigger payload
into the run prompt. The secret is sent in headers, never embedded in the URL.

Desktop supports `Authorization: Bearer`, `x-open-cowork-webhook-secret`, or
timestamped HMAC. Public Cloud ingress requires timestamped HMAC and rejects
raw bearer/shared-secret authentication.

An ordinary playbook card displays and copies only the non-secret URL. To
provision the first secret or rotate an existing one, choose **Regenerate** and
confirm. The mutation returns the new secret once, and the Playbooks page copies
a ready-to-run command directly to the clipboard. Desktop commands use bearer
authentication:

```bash
curl -X POST 'http://127.0.0.1:47839/workflows/<workflow-id>' \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <webhook-secret>' \
  --data '{"source":"manual"}'
```

Cloud commands calculate a timestamped HMAC over the exact raw body and require
`openssl`. The UI does not render or retain either one-time reveal. If clipboard
access fails, the reveal is discarded; regenerate again to receive a new
secret. Workflow list/detail responses, tool results, transcripts, and Desktop
cache records contain only public trigger metadata.

For webhook senders that should not handle raw bearer secrets, sign the raw
JSON body with `HMAC-SHA256(secret, "<timestamp>.<raw-body>")` and send:

```bash
curl -X POST 'http://127.0.0.1:47839/workflows/<workflow-id>' \
  -H 'content-type: application/json' \
  -H 'x-open-cowork-timestamp: 2026-05-16T12:00:00.000Z' \
  -H 'x-open-cowork-signature: sha256=<hex-digest>' \
  --data '{"source":"manual"}'
```

Webhook payloads are bounded and must be JSON objects.

## Run Lifecycle

```mermaid
stateDiagram-v2
    [*] --> SetupChat: Add playbook
    SetupChat --> Preview: Workflow Designer calls preview_workflow
    Preview --> SetupChat: user edits or answers questions
    Preview --> Saved: user confirms and Workflow Designer calls create_workflow with preview token
    Saved --> RunChat: manual, schedule, or webhook trigger
    RunChat --> Completed: assistant finishes
    RunChat --> Failed: runtime or session error
    Completed --> Saved
    Failed --> Saved
```

Each run is just another OpenCode session. The selected agent receives the
saved instructions plus the trigger payload. Open Cowork records the resulting
thread, status, and final summary.

## Playbooks Page

The Playbooks page is a control surface, not a second chat UI.

It shows:

- saved playbooks
- current status
- lead coworker
- linked skills/tools
- trigger summary
- webhook URL without credentials
- latest run status and summary

Actions:

- **Add playbook** opens a setup chat.
- **Open setup chat** reopens the Workflow Designer setup chat.
- **Open latest run** reopens the exact execution chat represented by the
  displayed run summary.
- **Run** starts a manual run.
- **Pause/Resume** controls scheduled and webhook execution.
- **Archive** stops schedules and webhook triggers, revokes any webhook secret,
  then moves the playbook to the archived view without deleting its history.
- **Restore** returns an archived playbook to the active view; it does not run
  the playbook automatically. For a webhook playbook, **Create replacement**
  creates and copies a replacement secret, then restores the playbook as one
  action.
- **Regenerate** provisions or rotates the webhook authorization secret after
  destructive confirmation, invalidating the previous secret and copying the
  one-time deployment-specific authorized curl command.

## When To Use Playbooks

Use **chat** when the work is ad hoc or exploratory.

Use **playbooks** when:

- the same task should happen again
- a schedule or webhook should trigger it
- the task needs a remembered definition
- the result should be linked to durable run history

Examples:

- daily inbox summary
- weekly metrics report
- PR triage
- monthly customer-risk scan
- webhook-triggered ticket enrichment

## Boundary

Playbooks must stay a product layer over OpenCode.

They may compose coworkers (OpenCode agents), skills, tools, schedules, and
durable metadata. They must not reimplement OpenCode execution, tool semantics,
approvals, or native agent delegation.
