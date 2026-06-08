import type { CloudWebRouteId } from './app-shell.ts'

export type CloudWebAdminSurfaceEntry = {
  routeId: CloudWebRouteId
  label: string
  desktopSurface: string
  cloudAffordance: string
  sensitiveBoundary: string
  disabledReason: string
  tests: string[]
}

export const CLOUD_WEB_ADMIN_SURFACE_MATRIX: CloudWebAdminSurfaceEntry[] = [
  {
    routeId: 'org',
    label: 'Workspace Profile',
    desktopSurface: 'Desktop account, workspace, and profile status surfaces',
    cloudAffordance: 'Show signed-in org identity, role, profile, and public sign-in state.',
    sensitiveBoundary: 'Bootstrap and signed-out state expose only public branding, route metadata, endpoint metadata, and feature flags.',
    disabledReason: 'Signed-in workspace details require Cloud authentication.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'members',
    label: 'Members',
    desktopSurface: 'Desktop account/settings identity context',
    cloudAffordance: 'Manage org member roles, invites, activation, suspension, and invite-mode state.',
    sensitiveBoundary: 'Member rows expose identity, role, and status only; authorization remains server-side.',
    disabledReason: 'Member administration requires an org owner or admin role.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'policy',
    label: 'Profiles & Policy',
    desktopSurface: 'Desktop runtime settings, capability policy, and Health Center',
    cloudAffordance: 'Show Cloud profile features, project-source policy, runtime guardrails, gateway policy, and worker health.',
    sensitiveBoundary: 'Cloud Web reports policy and health summaries without configuring local runtime, host paths, or stdio MCP processes.',
    disabledReason: 'Policy is read-only in Cloud Web; privileged worker details may require operator access.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'byok',
    label: 'BYOK',
    desktopSurface: 'Desktop provider credential setup',
    cloudAffordance: 'Add, rotate, validate, and disable provider credentials through write-only Cloud APIs.',
    sensitiveBoundary: 'Provider keys are never rendered after submission; the browser receives metadata such as provider id, status, last4, and validation timestamps.',
    disabledReason: 'BYOK management requires an org owner or admin role.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'connections',
    label: 'Connections',
    desktopSurface: 'Desktop Cloud connection and Gateway pairing surfaces',
    cloudAffordance: 'Issue scoped Desktop, Gateway, and admin API tokens with one-time plaintext reveal.',
    sensitiveBoundary: 'Token plaintext is shown once after creation and is not stored in persistent browser state.',
    disabledReason: 'Connection token issuance requires an org owner or admin role.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'billing',
    label: 'Billing',
    desktopSurface: 'Desktop entitlement and setup status surfaces',
    cloudAffordance: 'Show managed billing mode, plan state, checkout/portal actions, and resolved entitlements.',
    sensitiveBoundary: 'Billing renders plan and entitlement metadata only; provider integration stays behind the Cloud API.',
    disabledReason: 'Billing changes require an org owner or admin role and a managed billing deployment.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'gateway',
    label: 'Headless Gateway',
    desktopSurface: 'Desktop Gateway connection and workflow delivery status',
    cloudAffordance: 'Configure headless agents, channel bindings, setup guidance, and delivery backlog controls.',
    sensitiveBoundary: 'Channel credential refs, delivery targets, payloads, provider internals, and errors are browser-sanitized before rendering.',
    disabledReason: 'Gateway administration requires an org owner or admin role.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'audit',
    label: 'Audit',
    desktopSurface: 'Desktop diagnostics and sensitive-action history context',
    cloudAffordance: 'Browse and export redacted administrative events for sensitive Cloud actions.',
    sensitiveBoundary: 'Audit metadata must be server-redacted and is sanitized again before display or export.',
    disabledReason: 'Audit access requires an org owner or admin role.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'usage',
    label: 'Usage',
    desktopSurface: 'Desktop chat cost, token, and runtime status summaries',
    cloudAffordance: 'Show quota windows, recent metering totals, and bounded usage event samples.',
    sensitiveBoundary: 'Usage events include metering dimensions only, never prompts, provider keys, or tokens.',
    disabledReason: 'Usage is read-only and depends on the Cloud usage API being available.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
  {
    routeId: 'diagnostics',
    label: 'Diagnostics',
    desktopSurface: 'Desktop Health Center and support bundle surfaces',
    cloudAffordance: 'Prepare redacted health summaries and support bundles for Cloud runtime, BYOK, gateway, and object-store state.',
    sensitiveBoundary: 'Diagnostics are recursively redacted and array-capped before rendering or download.',
    disabledReason: 'Diagnostics require an org owner or admin role in Cloud Web and may still be denied by operator-token Cloud API policy.',
    tests: ['render.test.ts', 'browser-e2e.test.ts'],
  },
]

export function cloudWebAdminSurfaceForRoute(routeId: CloudWebRouteId) {
  return CLOUD_WEB_ADMIN_SURFACE_MATRIX.find((entry) => entry.routeId === routeId) || null
}

export function cloudWebAdminRouteSummary(routeId: CloudWebRouteId, fallback: string) {
  return cloudWebAdminSurfaceForRoute(routeId)?.cloudAffordance || fallback
}
