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
  | 'tools-skills'
  | 'artifacts'
  | 'workflows'
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
    label: 'Chat History',
    availability: 'shared',
    desktopSurface: 'Desktop thread list and sidebar chat history',
    cloudRouteIds: ['threads'],
    cloudAffordance: 'List, filter, page, and reopen tenant-scoped Cloud conversations.',
    boundary: 'Cloud Web reads Cloud session records and projections through the Cloud API; Desktop may also show local sessions.',
    disabledReason: null,
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'chat',
    label: 'Chat',
    availability: 'shared',
    desktopSurface: 'Desktop Chat view',
    cloudRouteIds: ['chat'],
    cloudAffordance: 'Render a chat-first Cloud session timeline, create a chat-only session on first send, and submit prompts through durable Cloud commands.',
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
    desktopSurface: 'Desktop chat approval and question queue',
    cloudRouteIds: ['chat'],
    cloudAffordance: 'Render pending and resolved approvals/questions and answer them through Cloud API endpoints.',
    boundary: 'Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses.',
    disabledReason: 'Response controls disable while a response is pending or when no active Cloud session is selected.',
    tests: ['browser-e2e.test.ts'],
  },
  {
    conceptId: 'agents',
    label: 'Agents',
    availability: 'shared',
    desktopSurface: 'Desktop Agents page and chat agent picker',
    cloudRouteIds: ['agents'],
    cloudAffordance: 'Show profile-allowed agents, built-in/custom metadata, and a Start chat action.',
    boundary: 'Cloud Web displays policy-safe agent metadata and cannot edit local custom agent files.',
    disabledReason: 'Start chat disables when chat or agent browsing is disabled by profile policy.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'tools-skills',
    label: 'Tools & Skills',
    availability: 'shared',
    desktopSurface: 'Desktop Tools & Skills capability map',
    cloudRouteIds: ['capabilities'],
    cloudAffordance: 'Show allowed tools, skills, MCP metadata, linked agents, and policy verdicts.',
    boundary: 'Cloud Web renders cloud-safe capability metadata; runtime execution remains owned by OpenCode workers.',
    disabledReason: 'Capability browsing explains policy-disabled agents, custom skills, or custom MCPs.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'artifacts',
    label: 'Artifacts',
    availability: 'shared',
    desktopSurface: 'Desktop session inspector Artifacts tab',
    cloudRouteIds: ['artifacts', 'chat'],
    cloudAffordance: 'Show artifact cards, loaded-chat history, sanitized metadata, explicit view/download actions, and selected-chat previews.',
    boundary: 'Cloud Web fetches artifact bodies only after explicit user action and strips object-store internals from metadata.',
    disabledReason: 'Artifact actions disable when no artifact id or Cloud chat is available.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    conceptId: 'workflows',
    label: 'Workflows',
    availability: 'shared',
    desktopSurface: 'Desktop Workflows page',
    cloudRouteIds: ['workflows', 'chat'],
    cloudAffordance: 'Create, list, run, pause, resume, archive, and inspect Cloud workflow definitions and run threads.',
    boundary: 'Cloud Web runs saved workflows through Cloud workflow APIs; local launch-at-login and native notifications remain Desktop settings.',
    disabledReason: 'Workflow controls disable when org profile policy disables workflows or a workflow is archived.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
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
