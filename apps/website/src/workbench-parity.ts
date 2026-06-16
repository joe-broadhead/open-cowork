import type { CloudWebRouteId } from './app-shell.ts'

export type CloudWebWorkbenchParityAvailability =
  | 'shared'
  | 'cloud-only'
  | 'desktop-only'
  | 'intentionally-unavailable'

export type CloudWebWorkbenchConceptId =
  | 'threads'
  | 'chat'
  | 'runtime-status'
  | 'approvals-questions'
  | 'agents'
  | 'hire-coworker'
  | 'tools-skills'
  | 'artifacts'
  | 'knowledge'
  | 'workflows'
  | 'channels'
  | 'settings'
  | 'objectives'
  | 'cloud-project-sources'
  | 'local-filesystem'
  | 'local-stdio-mcps'
  | 'machine-runtime-config'

export type CloudWebWorkbenchParityEntry = {
  conceptId: CloudWebWorkbenchConceptId
  label: string
  availability: CloudWebWorkbenchParityAvailability
  desktopSurface: string
  cloudRouteIds: CloudWebRouteId[]
  cloudAffordance: string
  boundary: string
  disabledReason: string | null
  tests: string[]
}

export const CLOUD_WEB_WORKBENCH_PARITY_MATRIX: CloudWebWorkbenchParityEntry[] = [
  {
    conceptId: 'threads',
    label: 'Projects and Kanban',
    availability: 'shared',
    desktopSurface: 'Desktop Projects workspace',
    cloudRouteIds: ['threads'],
    cloudAffordance: 'Browse project objectives, five-column Kanban task state, task drawer details, and linked Cloud work without exposing local paths.',
    boundary: 'Cloud Web reads and mutates durable coordination state through the Cloud API; execution and session semantics remain OpenCode-owned.',
    disabledReason: null,
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'chat',
    label: 'Home Launchpad and Chat',
    availability: 'shared',
    desktopSurface: 'Desktop Home launchpad and Chat view',
    cloudRouteIds: ['chat'],
    cloudAffordance: 'Open a Studio launchpad with assign-to coworker selection, starter cards, in-motion feed, and team strip; create a chat-only Cloud session on first send; submit prompts through durable Cloud commands.',
    boundary: 'Cloud Web never builds a browser-only projection model or invokes local OpenCode runtime commands.',
    disabledReason: 'Composer controls disable when signed out, chat policy is disabled, a submit is in progress, or the selected chat is closed.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'runtime-status',
    label: 'Runtime Status',
    availability: 'shared',
    desktopSurface: 'Desktop status bar and chat inspector context cards',
    cloudRouteIds: ['chat'],
    cloudAffordance: 'Show status, streaming state, cost, token usage, context, compactions, tool calls, task runs, todos, and errors from Cloud projections.',
    boundary: 'Cloud Web reports projected Cloud runtime state only; machine health and local model controls remain Desktop-owned.',
    disabledReason: null,
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'approvals-questions',
    label: 'Approvals & Questions',
    availability: 'shared',
    desktopSurface: 'Desktop Approvals route plus inline chat approval and question cards',
    cloudRouteIds: ['chat', 'approvals'],
    cloudAffordance: 'Render a standalone cross-chat queue plus inline chat cards; allow once, deny, reply, and reject through Cloud API endpoints.',
    boundary: 'Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses.',
    disabledReason: 'Response controls disable while a response is pending; persistent Always allow remains Cloud workspace policy, not a browser-side runtime grant.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    conceptId: 'agents',
    label: 'Coworkers',
    availability: 'shared',
    desktopSurface: 'Desktop Team/Coworkers page and chat coworker picker',
    cloudRouteIds: ['agents'],
    cloudAffordance: 'Show profile-allowed coworkers, built-in/custom metadata, and a Start chat action.',
    boundary: 'Cloud Web displays policy-safe coworker metadata and cannot edit local custom agent files.',
    disabledReason: 'Start chat disables when chat or coworker browsing is disabled by profile policy.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'hire-coworker',
    label: 'Hire a Coworker',
    availability: 'desktop-only',
    desktopSurface: 'Desktop Team/Coworkers Hire a coworker wizard',
    cloudRouteIds: ['agents'],
    cloudAffordance: 'Show policy-safe coworker metadata and Start chat only; custom coworker creation and permission editing remain unavailable.',
    boundary: 'The Hire wizard edits local custom-agent files, provider/model preferences, and OpenCode permission config owned by the Desktop runtime boundary.',
    disabledReason: 'Hire a coworker is Desktop-only because Cloud Web cannot edit local custom agent files, local provider settings, or machine runtime permissions.',
    tests: ['render.test.ts', 'studio-production-qa.test.ts'],
  },
  {
    conceptId: 'tools-skills',
    label: 'Tools & Skills',
    availability: 'shared',
    desktopSurface: 'Desktop Tools & Skills capability map',
    cloudRouteIds: ['capabilities'],
    cloudAffordance: 'Show allowed tools, skills, MCP metadata, linked coworkers, and policy verdicts.',
    boundary: 'Cloud Web renders cloud-safe capability metadata; runtime execution remains owned by OpenCode workers.',
    disabledReason: 'Capability browsing explains policy-disabled coworkers, custom skills, or custom MCPs.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'objectives',
    label: 'Objectives and Tasks',
    availability: 'shared',
    desktopSurface: 'Desktop Projects board and chat objective context',
    cloudRouteIds: ['threads'],
    cloudAffordance: 'Show durable project objectives, task specs, stage chips, assignees, Cleo planning, and linked-session work targets.',
    boundary: 'Cloud Web consumes the coordination API only; it does not invent project/task state or execute task work in the browser.',
    disabledReason: null,
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'artifacts',
    label: 'Artifacts',
    availability: 'shared',
    desktopSurface: 'Desktop cross-project Artifacts library and session inspector artifact actions',
    cloudRouteIds: ['artifacts', 'chat'],
    cloudAffordance: 'Show an index-backed cross-project artifact library with kind/status filters, author coworker, source project, sanitized metadata, and explicit Open/Export actions.',
    boundary: 'Cloud Web reads artifact index metadata through Cloud APIs and fetches artifact bodies only after explicit user action while stripping object-store internals.',
    disabledReason: 'Artifact actions disable when no artifact id or Cloud chat is available.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'knowledge',
    label: 'Knowledge',
    availability: 'shared',
    desktopSurface: 'Desktop Knowledge page and chat capture action',
    cloudRouteIds: ['knowledge', 'chat'],
    cloudAffordance: 'Show Spaces, versioned pages, reviewable proposals, knowledge-trail backlinks, graph navigation, and a Capture to knowledge action that creates pending proposals.',
    boundary: 'Cloud Web consumes the Knowledge API only; Open Cowork stores versioned product knowledge while OpenCode remains responsible for execution and chat events.',
    disabledReason: 'Capture requires a writable Space role; review requires a Maintainer Space role plus an owner/admin Cloud role or admin-scoped API token. Reader Spaces remain read-only.',
    tests: ['render.test.ts', 'browser-e2e.test.ts', 'studio-production-qa.test.ts'],
  },
  {
    conceptId: 'workflows',
    label: 'Playbooks',
    availability: 'shared',
    desktopSurface: 'Desktop Playbooks page',
    cloudRouteIds: ['workflows', 'chat'],
    cloudAffordance: 'Create, list, run, pause, resume, archive, and inspect Cloud playbook definitions and run chats.',
    boundary: 'Cloud Web runs saved playbooks through Cloud workflow APIs; local launch-at-login and native notifications remain Desktop settings.',
    disabledReason: 'Playbook controls disable when org profile policy disables workflows or a playbook is archived.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'channels',
    label: 'Channels',
    availability: 'shared',
    desktopSurface: 'Desktop Gateway/channel status and channel-backed chat context',
    cloudRouteIds: ['channels', 'chat'],
    cloudAffordance: 'Show provider reach, connected channel bindings, People roles, Watches, delivery status, and linked Cloud run chats with admin-gated setup controls.',
    boundary: 'Cloud Web reads channel state through tenant-scoped Cloud APIs; Gateway delivery, provider adapters, and OpenCode execution remain service-owned.',
    disabledReason: 'Channel setup, People resolution, and Watch mutation controls require owner/admin permissions; member reads remain available.',
    tests: ['browser-e2e.test.ts', 'render.test.ts'],
  },
  {
    conceptId: 'settings',
    label: 'User Settings',
    availability: 'shared',
    desktopSurface: 'Desktop Settings dialog',
    cloudRouteIds: ['settings'],
    cloudAffordance: 'Show user-scoped Appearance, Notifications, Privacy, and read-only AI provider/profile status without exposing admin BYOK or local machine runtime controls.',
    boundary: 'Cloud Web persists durable user-scoped appearance, notification, and privacy preferences through the Cloud settings API; org secrets, provider keys, and local OpenCode runtime settings remain Admin/Desktop-owned.',
    disabledReason: null,
    tests: ['render.test.ts', 'cloud-theme.test.ts', 'studio-production-qa.test.ts'],
  },
  {
    conceptId: 'cloud-project-sources',
    label: 'Cloud Project Sources',
    availability: 'cloud-only',
    desktopSurface: 'Desktop local workspace picker and cloud copy/upload flows',
    cloudRouteIds: ['threads'],
    cloudAffordance: 'Start project-backed Cloud chats from allowed git repositories or explicit browser-uploaded snapshots.',
    boundary: 'Cloud policy validates git and snapshot sources before execution.',
    disabledReason: 'Project source creation fails closed when policy denies the source.',
    tests: ['browser-e2e.test.ts'],
  },
  {
    conceptId: 'local-filesystem',
    label: 'Local Filesystem',
    availability: 'intentionally-unavailable',
    desktopSurface: 'Desktop local project directories and sandbox artifacts',
    cloudRouteIds: ['threads', 'artifacts'],
    cloudAffordance: 'Use git URLs, managed Cloud project sources, uploaded snapshots, and Cloud artifacts instead.',
    boundary: 'Browser sessions must not implicitly read or upload host paths from the user machine.',
    disabledReason: 'Local paths are Desktop-only because they depend on local filesystem access and user consent inside the desktop shell.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'local-stdio-mcps',
    label: 'Local Stdio MCPs',
    availability: 'intentionally-unavailable',
    desktopSurface: 'Desktop local MCP process configuration',
    cloudRouteIds: ['capabilities', 'agents'],
    cloudAffordance: 'Show only policy-safe MCP metadata that has been converted into the Cloud profile.',
    boundary: 'Cloud Web cannot spawn local stdio MCP processes or expose command lines, environment variables, or secret refs.',
    disabledReason: 'Local stdio MCPs are Desktop-only unless represented by a Cloud-safe capability profile.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'machine-runtime-config',
    label: 'Machine Runtime Config',
    availability: 'desktop-only',
    desktopSurface: 'Desktop setup, model/provider controls, and runtime health center',
    cloudRouteIds: ['chat', 'agents', 'capabilities'],
    cloudAffordance: 'Show current Cloud profile, feature flags, and projected runtime state.',
    boundary: 'Cloud Web does not configure the local machine runtime, provider defaults, local approvals mode, or desktop notification settings.',
    disabledReason: 'Machine runtime configuration is Desktop-only because it depends on local app settings and host process control.',
    tests: ['render.test.ts'],
  },
]

export function cloudWebWorkbenchParityForRoute(routeId: CloudWebRouteId) {
  return CLOUD_WEB_WORKBENCH_PARITY_MATRIX.filter((entry) => entry.cloudRouteIds.includes(routeId))
}

export function cloudWebWorkbenchRouteSummary(routeId: CloudWebRouteId, fallback: string) {
  return cloudWebWorkbenchParityForRoute(routeId).find((entry) => entry.availability === 'shared')?.cloudAffordance || fallback
}
