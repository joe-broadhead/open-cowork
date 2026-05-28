# Desktop App Guide

Open Cowork is being simplified around the surfaces that users already
understand and that map cleanly onto OpenCode:

- `Home` — start a chat, attach context, choose a model, or @mention an agent
- `Chat` — the OpenCode session transcript, approvals, questions, files, and delegated agent work
- `Threads` — searchable history and saved work context
- `Workflows` — repeatable tasks created from Workflow Designer setup threads, with manual, scheduled, and webhook runs
- `Agents` — built-in and custom OpenCode agents with curated tools and skills
- `Tools & Skills` — MCP tools, OpenCode skills, credentials, and capability relationships
- `Settings` — appearance, models, permissions, storage, and workflow run behavior

Team dashboards, incident-control dashboards, and unsupervised autonomous
learning controls are not part of the active app surface. User-invoked
improvement work still belongs in Chat through the bundled `autoresearch`
skill and agent.

```mermaid
flowchart TD
    Home["Home<br/>composer · attachments · @agent pills"]
    Chat["Chat<br/>session UI · streamed events · approvals"]
    Threads["Threads<br/>search · facets · tags · saved context"]
    Workflows["Workflows<br/>setup threads · triggers · runs"]
    Agents["Agents<br/>built-in + custom"]
    ToolsSkills["Tools & Skills<br/>MCPs · skills · credentials"]
    Settings["Settings<br/>models · permissions · storage"]

    Home -->|submit prompt| Chat
    Home -->|open recent work| Threads
    Threads -->|open thread| Chat
    Chat -->|@agent| Agents
    Chat -->|tool calls and artifacts| ToolsSkills
    Workflows -->|run thread| Chat
    Workflows -->|uses agents| Agents
    Workflows -->|uses tools and skills| ToolsSkills
    Settings -->|configure providers| Chat
    Settings -->|configure routing| Workflows
```

## Product Language And Density Standards

Open Cowork should read like a focused workbench, not an inventory of internal
runtime kinds. Use these terms in user-facing copy:

- **Chat** for direct OpenCode sessions.
- **Agent** for a reusable OpenCode worker profile.
- **Tool** for MCP/native capability access.
- **Skill** for packaged OpenCode instructions.
- **Workflow** for recurring or repeatable work saved from a Workflow Designer setup thread.
- **Run** for one execution of a workflow.
- **Artifact** for generated files, charts, reports, or delivery drafts.
- **OpenCode** for execution-engine details that matter to users.

Avoid presenting dormant implementation concepts such as team dashboards,
incident-control dashboards, or unsupervised autonomous learning loops as current product features. If a feature
does not help a user start work, delegate to an agent, curate tools/skills, or
review a workflow, it does not belong in the primary app navigation.

Shared visible statuses should stay consistent across Chat, Threads, and
Workflows: `active`, `running`, `failed`, `paused`, and `archived`.

Workspace copy should also stay stable:

- **Local workspace** means private local desktop state backed by the local
  OpenCode runtime.
- **Cloud workspace** means synced cloud state shared with web and gateway
  clients through Open Cowork Cloud.
- **Offline cached** means cached cloud state is visible, but cloud sends and
  mutations are disabled until the connection recovers.
- **Auth required** means the desktop has a cloud connection but no usable
  token.
- **Policy disabled** means the org/profile returned a support-matrix verdict
  that blocks the action.
- **Local-only action** means the action depends on local host paths, local
  stdio MCPs, or machine runtime config and must not run in a cloud workspace.
- **Cloud-safe action** means the action can be represented through the cloud
  control plane without implicit local file, local MCP, or secret upload.

The renderer should not infer those states from workspace ids alone. Use
`workspace.support()` for action-level capability and policy verdicts, then
show the returned reason when disabling a control.

For dense operational lists, prefer compact tables, split panes, saved filters,
and bulk-safe actions. Use cards for browse/detail previews, not as the only
way to manage large inventories. Empty states should offer a direct next
action and avoid marketing copy.

## Home

![Home composer with greeting, @-agent suggestion pills, and the execution status strip](assets/auto/home.png)

Home is the fastest path into useful work:

- model and reasoning controls match the in-thread composer
- file attachments use the same validation path as Chat
- @agent suggestion pills pre-fill native OpenCode agent mentions
- recent threads let users return to active work without a separate overview page

Submitting from Home creates or activates an OpenCode session and routes
directly into Chat. Home should not accumulate status dashboards or secondary
workflow-monitoring cards.

## Chat

![Chat composer mid-thread with the @-mention picker open over the sub-agent list](assets/auto/chat-mention-picker.png)

Chat is the runtime surface. OpenCode owns execution; Open Cowork projects the
events into a desktop-friendly transcript with:

- streamed assistant output
- tool calls and artifacts
- approvals and questions
- sub-agent task cards
- model, agent mode, reasoning, and attachment controls
- session inspection and export helpers

The transcript should stay faithful to OpenCode history. Do not invent a
second execution model in the renderer.

## Threads

Threads is the place to find prior work. It should optimize for fast recall:

- search
- project and status facets
- saved filters where they are useful
- metadata that helps users decide which thread to reopen

Threads can link to workflow runs, but it should stay focused on recall and
reopening work.

## Workflows

![Workflows page showing the Add workflow setup-thread entry point](assets/auto/workflows-overview.png)

Workflows are saved repeatable tasks created from normal OpenCode threads.
They own:

- setup-thread creation with the Workflow Designer agent
- manual, scheduled, and webhook triggers
- local webhook URLs, authorization-header examples, and secret rotation
- run status, summaries, and linked run threads

The execution path still goes through OpenCode-native agents and approvals:

- Workflow Designer clarifies and saves the workflow through the Workflows MCP
- the selected agent executes each saved run
- specialist agents can still be called through OpenCode-native delegation

Workflows should feel like a simple list of saved repeatable tasks, not a
separate agent runtime or operations dashboard.

## Agents

![Agents page showing built-in and custom agents in a portrait grid](assets/auto/agents.png)

Agents are OpenCode-native agent configurations composed by Open Cowork. The
Agents surface should make it clear:

- what the agent is for
- which tools and skills it can use
- whether it is built-in, configured, custom, or runtime-provided
- what model and reasoning settings it prefers
- where it can be used from Chat or Workflows

Agent UI can have a playful character feel, but the stats must stay grounded in
real permissions, skills, tools, and runtime settings.

## Tools & Skills

![Tools & Skills page listing tools and skills with type, source, and tool counts](assets/auto/capabilities-tools.png)

Tools & Skills is the capability catalog. It should answer:

- which MCP/native tools are available
- which skills are installed
- which agents and workflows use each capability
- which credentials or permissions are required
- whether a capability is bundled, configured, or custom

Skills should be grouped and highlighted by the tools they use so users can
understand the real authority behind an agent or workflow.

## Settings

Settings holds lower-frequency configuration:

- appearance and localization
- provider/model credentials
- shell and file-write permissions
- workflow launch, background, and notification behavior
- storage and cleanup

Settings should configure the core surfaces without introducing separate
product concepts.
