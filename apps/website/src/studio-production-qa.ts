import type { CloudWebRouteId } from './app-shell.ts'

export type StudioQaViewport = 'desktop' | 'tablet' | 'mobile'

export type StudioQaState =
  | 'loading'
  | 'empty'
  | 'error'
  | 'disabled'
  | 'permission-gated'
  | 'offline-disconnected'
  | 'retry'
  | 'destructive-confirmation'
  | 'one-time-reveal'

export type StudioVisualQaEntry = {
  id: string
  label: string
  routeIds: CloudWebRouteId[]
  desktopSurface: string
  cloudCheck: string
  states: StudioQaState[]
  boundary: string
  evidence: string[]
  viewports: StudioQaViewport[]
}

export type StudioProductionAuditEntry = {
  id: string
  requirement: string
  evidence: string[]
}

export type OpenWikiDeferralContract = {
  id: 'openwiki-knowledge'
  status: 'deferred'
  routeIds: CloudWebRouteId[]
  visibleCtas: string[]
  runtimeDependencies: string[]
  contract: string
  releaseRequirement: string
}

const allViewports: StudioQaViewport[] = ['desktop', 'tablet', 'mobile']

export const STUDIO_VISUAL_QA_MATRIX: StudioVisualQaEntry[] = [
  {
    id: 'home-chat-composer',
    label: 'Home launchpad, Chat, and composer',
    routeIds: ['chat'],
    desktopSurface: 'Home launchpad and Chat composer-first runtime surface',
    cloudCheck: 'Default route opens to the launchpad with assign-to coworker selection, starter cards, in-motion feed, team strip, disabled signed-out send controls, and Cloud command submission after auth.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry'],
    boundary: 'Cloud Web consumes Cloud session projections and commands only; OpenCode owns session execution and event semantics.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/browser-e2e.test.ts', 'apps/website/src/browser-real-e2e.spec.ts'],
    viewports: allViewports,
  },
  {
    id: 'projects-and-kanban',
    label: 'Projects and Kanban',
    routeIds: ['threads'],
    desktopSurface: 'Projects list, five-column Kanban board, task drawer, and Cleo planning controls',
    cloudCheck: 'Projects render objective cards, progress, team avatars, Backlog to Done columns, task drawer actions, and API-backed Plan with Cleo behavior instead of a thread table.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry'],
    boundary: 'Cloud Web reads and mutates coordination state through Cloud APIs only; OpenCode remains the owner of execution, sessions, approvals, and runtime events.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/browser-e2e.test.ts', 'tests/cloud-http-server.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'runtime-review-and-approvals',
    label: 'Runtime review, approvals, and questions',
    routeIds: ['chat', 'approvals', 'artifacts'],
    desktopSurface: 'Chat transcript, task lanes, approvals, questions, todos, runtime status, cost, tokens, and review panel',
    cloudCheck: 'Messages, delegated specialist lanes, running/completed/error task states, inline and standalone approval/question queues, deliverables, todos, artifacts, cost, token usage, and follow-up actions are visible from Cloud projections.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry', 'destructive-confirmation'],
    boundary: 'Approval and question semantics remain OpenCode-owned; Cloud Web only submits tenant-scoped responses through Cloud API endpoints.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/react-workbench.test.ts', 'tests/cloud-session-projection-contract.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'coworkers-tools-and-skills',
    label: 'Coworkers, tools, and skills',
    routeIds: ['agents', 'capabilities'],
    desktopSurface: 'Team and Tools & Skills capability catalog',
    cloudCheck: 'Coworker cards, picker states, linked skills, linked tools, MCP policy verdicts, and Start chat actions use the shared Studio primitive language.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'retry'],
    boundary: 'Cloud Web renders policy-safe metadata only and cannot edit local custom agent files or spawn local stdio MCPs.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/react-workbench.test.ts', 'apps/website/src/accessibility.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'hire-coworker-wizard-boundary',
    label: 'Hire a coworker wizard boundary',
    routeIds: ['agents'],
    desktopSurface: 'Desktop four-step Hire a coworker wizard with Role, Abilities, Brain, and Permissions',
    cloudCheck: 'Agents route keeps the same coworker vocabulary and Start chat path while showing no local custom-agent editor; the parity matrix documents the Desktop-only reason.',
    states: ['disabled', 'permission-gated'],
    boundary: 'Cloud Web cannot edit local custom-agent files, local provider settings, or machine OpenCode permission config.',
    evidence: ['apps/desktop/src/renderer/components/agents/AgentBuilderPage.test.tsx', 'apps/website/src/workbench-parity.ts', 'apps/website/src/studio-production-qa.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'playbooks-and-runs',
    label: 'Playbooks and runs',
    routeIds: ['workflows'],
    desktopSurface: 'Playbooks list, saved workflow setup chats, run controls, and run history',
    cloudCheck: 'Playbook cards, run rows, pause/resume/archive actions, empty states, and blocked policy copy behave like Desktop workflows while staying browser-bounded.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry', 'destructive-confirmation'],
    boundary: 'Cloud Web runs saved playbooks through Cloud workflow APIs; OpenCode-native agents still execute the work.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/browser-e2e.test.ts', 'tests/cloud-http-server.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'channels-and-artifacts',
    label: 'Channels and artifacts',
    routeIds: ['channels', 'artifacts', 'chat'],
    desktopSurface: 'Channel status, linked run chats, indexed artifact library cards, and review-first artifact previews',
    cloudCheck: 'Connected channel coworkers, bindings, delivery status, searchable artifact library with status/provenance, sanitized metadata, explicit Open/Export actions, and selected-chat previews stay reachable without admin controls.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry'],
    boundary: 'Provider payloads, signed URLs, object-store internals, channel secrets, and delivery targets are stripped before rendering.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/react-workbench.test.ts', 'apps/website/src/browser-real-e2e.spec.ts'],
    viewports: allViewports,
  },
  {
    id: 'team-and-member-admin-boundary',
    label: 'Team and member admin boundary',
    routeIds: ['org', 'members', 'policy', 'usage'],
    desktopSurface: 'Desktop account, Team context, Settings policy, Health Center, and usage summaries',
    cloudCheck: 'Org profile, member rows, invite/role controls, policy summaries, usage quotas, and worker health are visually grouped under Admin without dominating the default Studio path.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'retry', 'destructive-confirmation'],
    boundary: 'Browser disabled controls are ergonomic only; Cloud API authorization remains server-side and tenant-scoped.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/react-integration.test.ts', 'apps/website/src/app-api.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'user-settings',
    label: 'User Settings',
    routeIds: ['settings'],
    desktopSurface: 'Desktop Settings dialog: appearance, permissions, notifications, privacy, and profile status',
    cloudCheck: 'Cloud Web exposes user-scoped Appearance, Notifications, Privacy, and read-only AI provider/profile status as a Studio route, while keeping BYOK and org policy in Admin.',
    states: ['loading', 'disabled', 'permission-gated'],
    boundary: 'Cloud Web persists durable user-scoped preferences through Cloud settings metadata; provider keys, local machine runtime config, and org policy stay Desktop/Admin-owned.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/cloud-theme.test.ts', 'apps/website/src/studio-production-qa.test.ts'],
    viewports: allViewports,
  },
  {
    id: 'secrets-gateway-audit-diagnostics',
    label: 'Secrets, Gateway, audit, and diagnostics',
    routeIds: ['byok', 'connections', 'billing', 'gateway', 'audit', 'diagnostics'],
    desktopSurface: 'Desktop Cloud connection setup, Gateway pairing, provider credentials, billing, audit, and Health Center support bundle surfaces',
    cloudCheck: 'BYOK write-only rotation, one-time token reveal, gateway delivery controls, billing portal actions, audit export, diagnostics redaction, confirmations, and settled disabled states are visible and keyboard-reachable.',
    states: ['loading', 'empty', 'error', 'disabled', 'permission-gated', 'offline-disconnected', 'retry', 'destructive-confirmation', 'one-time-reveal'],
    boundary: 'Raw secrets, provider keys, auth headers, signed URLs, object-store internals, local paths, command lines, and environment variables must not render outside intentional safe reveal flows.',
    evidence: ['apps/website/src/render.test.ts', 'apps/website/src/react-integration.test.ts', 'tests/cloud-http-server.test.ts'],
    viewports: allViewports,
  },
]

export const STUDIO_PRODUCTION_AUDIT_CHECKLIST: StudioProductionAuditEntry[] = [
  {
    id: 'canonical-shared-tokens',
    requirement: 'Shared design tokens are the only canonical Studio token source for Desktop and Cloud Web.',
    evidence: ['packages/shared/src/design-tokens.ts', 'tests/design-tokens-sync.test.ts', 'docs/design-tokens.md'],
  },
  {
    id: 'shared-primitives-first',
    requirement: 'Shared Studio primitives are preferred before app-local component duplication.',
    evidence: ['packages/ui/src/', 'docs/design-system.md', 'apps/website/src/modularity.test.ts'],
  },
  {
    id: 'shared-product-vocabulary',
    requirement: 'Desktop and Cloud Web use the same user-facing vocabulary for shared concepts.',
    evidence: ['docs/desktop-app.md', 'docs/cloud-web-workbench.md', 'apps/website/src/workbench-parity.ts'],
  },
  {
    id: 'cloud-api-client-only',
    requirement: 'Cloud Web remains a Cloud API client and does not own execution, projection semantics, or OpenCode runtime behavior.',
    evidence: ['apps/website/src/app-api.ts', 'apps/website/src/modularity.test.ts', 'docs/architecture.md'],
  },
  {
    id: 'admin-not-default-path',
    requirement: 'Admin/setup controls are explicit secondary surfaces and do not dominate the default user path.',
    evidence: ['apps/website/src/app-shell.ts', 'apps/website/src/admin-surface-matrix.ts', 'docs/cloud-web-workbench.md'],
  },
  {
    id: 'safe-redaction',
    requirement: 'No raw secrets, signed URLs, object-store internals, local paths, command lines, environment variables, or provider payloads render outside intentional safe reveal flows.',
    evidence: ['apps/website/src/route-api-matrix.ts', 'apps/website/src/render.test.ts', 'tests/cloud-http-server.test.ts'],
  },
  {
    id: 'honest-performance-budgets',
    requirement: 'Performance budgets stay honest for added routes, surfaces, large fixtures, and responsive layouts.',
    evidence: ['apps/website/src/performance.test.ts', 'apps/website/src/modularity.test.ts', 'docs/cloud-web-workbench.md'],
  },
  {
    id: 'docs-match-shipped-behavior',
    requirement: 'Docs describe shipped behavior and explicit boundaries, not aspirational runtime behavior.',
    evidence: ['docs/cloud-web-workbench.md', 'docs/release-checklist.md', 'apps/website/src/studio-production-qa.test.ts'],
  },
]

export const OPENWIKI_DEFERRAL_CONTRACT: OpenWikiDeferralContract = {
  id: 'openwiki-knowledge',
  status: 'deferred',
  routeIds: [],
  visibleCtas: [],
  runtimeDependencies: [],
  contract: 'Knowledge/OpenWiki is intentionally deferred and ships with no Cloud Web route, no visible CTA, no runtime dependency, and no data-sync claim in this roadmap.',
  releaseRequirement: 'Create a separate future roadmap before adding a Knowledge route, CTA, sync contract, local OpenWiki checkout dependency, or runtime integration.',
}
