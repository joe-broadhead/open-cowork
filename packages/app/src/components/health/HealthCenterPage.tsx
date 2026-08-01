import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SETUP_HEALTH_CHECKS, SETUP_INTENTS, workspaceAuthorityContract, type DesktopPairingPublicRecord, type RuntimeCapabilityProvenanceRecord, type RuntimeCapabilityStatus, type RuntimeInputDiagnostics, type RuntimeStatus, type SetupHealthStatus, type WorkspaceApiSupport, type WorkspaceExecutionAuthority, type WorkspaceInfo, } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, type BadgeTone } from '@open-cowork/ui'

type WorkspaceHealth = {
  workspace: WorkspaceInfo
  support: WorkspaceApiSupport[]
}

type HealthSnapshot = {
  runtime: RuntimeStatus | null
  runtimeInputs: RuntimeInputDiagnostics | null
  workspaces: WorkspaceHealth[]
  pairings: DesktopPairingPublicRecord[]
  loadedAt: string | null
}

const INITIAL_SNAPSHOT: HealthSnapshot = {
  runtime: null,
  runtimeInputs: null,
  workspaces: [],
  pairings: [],
  loadedAt: null,
}

function statusBadgeTone(status: SetupHealthStatus | WorkspaceInfo['status']): BadgeTone {
  if (status === 'ready' || status === 'online') return 'success'
  if (status === 'degraded' || status === 'offline') return 'warning'
  if (status === 'action_required' || status === 'auth_required') return 'info'
  return 'danger'
}

function statusLabel(status: SetupHealthStatus | WorkspaceInfo['status']) {
  return status.replace(/_/g, ' ')
}

function capabilityBadgeTone(status: RuntimeCapabilityStatus): BadgeTone {
  if (status === 'active' || status === 'available') return 'success'
  if (status === 'auth-pending' || status === 'ask-gated') return 'info'
  if (status === 'disabled' || status === 'missing' || status === 'unknown') return 'warning'
  return 'danger'
}

function capabilityStatusPriority(status: RuntimeCapabilityStatus) {
  switch (status) {
    case 'blocked':
    case 'runtime-failure':
    case 'unsupported':
      return 0
    case 'auth-pending':
    case 'ask-gated':
    case 'disabled':
    case 'missing':
      return 1
    case 'unknown':
      return 2
    case 'active':
    case 'available':
      return 3
  }
}

type CapabilityRecoveryDetails = {
  singular: string
  plural: string
  recoverySingular: string
  recoveryPlural: string
}

function capabilityRecoveryDetails(kind: RuntimeCapabilityProvenanceRecord['kind']): CapabilityRecoveryDetails {
  switch (kind) {
    case 'provider':
      return {
        singular: t('health.capabilityKindProvider', 'Model provider'),
        plural: t('health.capabilityKindProviderPlural', 'Model providers'),
        recoverySingular: t('health.capabilityRecoveryProvider', 'Open Settings, then reconnect the affected model provider.'),
        recoveryPlural: t('health.capabilityRecoveryProviderPlural', 'Open Settings, then reconnect the affected model providers.'),
      }
    case 'model':
      return {
        singular: t('health.capabilityKindModel', 'Selected model'),
        plural: t('health.capabilityKindModelPlural', 'Selected models'),
        recoverySingular: t('health.capabilityRecoveryModel', 'Open Settings, then choose an available model.'),
        recoveryPlural: t('health.capabilityRecoveryModelPlural', 'Open Settings, then choose available replacements for the affected models.'),
      }
    case 'mcp':
      return {
        singular: t('health.capabilityKindMcp', 'Tool connection'),
        plural: t('health.capabilityKindMcpPlural', 'Tool connections'),
        recoverySingular: t('health.capabilityRecoveryMcp', 'Open Tools & Skills, then reconnect the affected tool connection.'),
        recoveryPlural: t('health.capabilityRecoveryMcpPlural', 'Open Tools & Skills, then reconnect the affected tool connections.'),
      }
    case 'skill':
      return {
        singular: t('health.capabilityKindSkill', 'Skill'),
        plural: t('health.capabilityKindSkillPlural', 'Skills'),
        recoverySingular: t('health.capabilityRecoverySkill', 'Open Tools & Skills, then re-enable the affected skill.'),
        recoveryPlural: t('health.capabilityRecoverySkillPlural', 'Open Tools & Skills, then re-enable the affected skills.'),
      }
    case 'agent':
      return {
        singular: t('health.capabilityKindAgent', 'Coworker'),
        plural: t('health.capabilityKindAgentPlural', 'Coworkers'),
        recoverySingular: t('health.capabilityRecoveryAgent', 'Open Team, then repair or re-enable the affected coworker.'),
        recoveryPlural: t('health.capabilityRecoveryAgentPlural', 'Open Team, then repair or re-enable the affected coworkers.'),
      }
    case 'tool':
      return {
        singular: t('health.capabilityKindTool', 'Tool'),
        plural: t('health.capabilityKindToolPlural', 'Tools'),
        recoverySingular: t('health.capabilityRecoveryTool', 'Open Tools & Skills, then reconnect or re-enable the affected tool.'),
        recoveryPlural: t('health.capabilityRecoveryToolPlural', 'Open Tools & Skills, then reconnect or re-enable the affected tools.'),
      }
    case 'workflow':
      return {
        singular: t('health.capabilityKindWorkflow', 'Playbook'),
        plural: t('health.capabilityKindWorkflowPlural', 'Playbooks'),
        recoverySingular: t('health.capabilityRecoveryWorkflow', 'Open Playbooks, then repair or re-enable the affected playbook.'),
        recoveryPlural: t('health.capabilityRecoveryWorkflowPlural', 'Open Playbooks, then repair or re-enable the affected playbooks.'),
      }
    case 'opencode-plugin':
      return {
        singular: t('health.capabilityKindOpenCodePlugin', 'OpenCode extension'),
        plural: t('health.capabilityKindOpenCodePluginPlural', 'OpenCode extensions'),
        recoverySingular: t('health.capabilityRecoveryOpenCodePlugin', 'Update or re-enable the affected OpenCode extension, then restart the runtime.'),
        recoveryPlural: t('health.capabilityRecoveryOpenCodePluginPlural', 'Update or re-enable the affected OpenCode extensions, then restart the runtime.'),
      }
  }
}

function formatEvidenceValue(value: string | number | boolean | string[] | null) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.join(', ') || 'none'
  return String(value)
}

function workspaceAuthority(workspace: WorkspaceInfo): WorkspaceExecutionAuthority {
  if (workspace.authority) return workspace.authority
  if (workspace.kind === 'local') return 'desktop_local'
  if (workspace.kind === 'gateway') return 'gateway_standalone'
  if (workspace.kind === 'paired_desktop') return 'desktop_paired'
  return 'cloud_worker'
}

function supportSummary(support: WorkspaceApiSupport[]) {
  const blocked = support.filter((entry) => entry.status === 'blocked_by_policy' || entry.status === 'not_supported')
  const readOnly = support.filter((entry) => entry.status === 'read_only')
  if (blocked.length > 0) return t('health.supportBlocked', '{{count}} blocked', { count: blocked.length })
  if (readOnly.length > 0) return t('health.supportReadOnly', '{{count}} read-only', { count: readOnly.length })
  if (support.length > 0) return t('health.supportSupported', '{{count}} supported', { count: support.length })
  return t('health.supportUnknown', 'support unknown')
}

function workspaceAction(workspace: WorkspaceInfo) {
  if (workspace.status === 'auth_required') return 'Sign in'
  if (workspace.status === 'offline' || workspace.status === 'error') return 'Sync'
  return null
}

function checkStatus(checkId: string, snapshot: HealthSnapshot): SetupHealthStatus {
  if (checkId === 'desktop.runtime.ready') return snapshot.runtime?.ready ? 'ready' : 'action_required'
  if (checkId === 'desktop.credentials.configured') {
    return snapshot.runtimeInputs?.providerId && snapshot.runtimeInputs?.modelId ? 'ready' : 'action_required'
  }
  if (checkId === 'workspace.authority.declared') return snapshot.workspaces.length > 0 ? 'ready' : 'unknown'
  if (checkId === 'workspace.cloud.authenticated') {
    const clouds = snapshot.workspaces.filter((entry) => entry.workspace.kind === 'cloud')
    if (clouds.length === 0) return 'unknown'
    return clouds.every((entry) => entry.workspace.status !== 'auth_required') ? 'ready' : 'action_required'
  }
  if (checkId === 'workspace.cloud.sync.reachable') {
    const clouds = snapshot.workspaces.filter((entry) => entry.workspace.kind === 'cloud')
    if (clouds.length === 0) return 'unknown'
    return clouds.some((entry) => entry.workspace.status === 'online') ? 'ready' : 'offline'
  }
  if (checkId.startsWith('pairing.')) {
    if (snapshot.pairings.length === 0) return 'unknown'
    return snapshot.pairings.some((pairing) => pairing.status === 'paired_online') ? 'ready' : 'offline'
  }
  return 'unknown'
}

function statusDotClass(tone: BadgeTone): string {
  return tone === 'success'
    ? 'status-dot--ok'
    : tone === 'warning'
      ? 'status-dot--warn'
      : tone === 'info'
        ? 'status-dot--info'
        : tone === 'danger'
          ? 'status-dot--error'
          : 'status-dot--idle'
}

function StatusPill({ status }: { status: SetupHealthStatus | WorkspaceInfo['status'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 text-2xs text-text-secondary capitalize">
      <span className={`status-dot ${statusDotClass(statusBadgeTone(status))}`} aria-hidden />
      {statusLabel(status)}
    </span>
  )
}

function CapabilityPill({ status }: { status: RuntimeCapabilityStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 text-2xs text-text-secondary capitalize">
      <span className={`status-dot ${statusDotClass(capabilityBadgeTone(status))}`} aria-hidden />
      {status.replace(/-/g, ' ')}
    </span>
  )
}

export function HealthCenterPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>(INITIAL_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const failures: string[] = []
      const { surface } = await window.coworkApi.app.metadata()
      const hasDesktopRuntime = surface === 'desktop'
      const [runtimeResult, runtimeInputsResult, workspacesResult, pairingsResult] = await Promise.allSettled([
        Promise.resolve().then(() => window.coworkApi.runtime.status()),
        hasDesktopRuntime
          ? Promise.resolve().then(() => window.coworkApi.app.runtimeInputs())
          : Promise.resolve(null),
        Promise.resolve().then(() => window.coworkApi.workspace.list()),
        hasDesktopRuntime
          ? Promise.resolve().then(() => window.coworkApi.desktopPairing.list())
          : Promise.resolve([]),
      ])
      const runtime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : (failures.push('runtime status'), null)
      const runtimeInputs = runtimeInputsResult.status === 'fulfilled' ? runtimeInputsResult.value : (failures.push('runtime inputs'), null)
      const workspaces = workspacesResult.status === 'fulfilled' ? workspacesResult.value : (failures.push('workspaces'), [])
      const pairings = pairingsResult.status === 'fulfilled' ? pairingsResult.value : (failures.push('pairings'), [])

      const supportResults = await Promise.allSettled((workspaces || []).map((workspace) => (
        window.coworkApi.workspace.support(workspace.id)
      )))
      const workspaceHealth = (workspaces || []).map((workspace, index) => {
        const result = supportResults[index]
        if (!result || result.status === 'rejected') {
          failures.push(`support for ${workspace.label}`)
          return { workspace, support: [] }
        }
        return { workspace, support: result.value }
      })
      setSnapshot({
        runtime,
        runtimeInputs,
        workspaces: workspaceHealth,
        pairings,
        loadedAt: new Date().toISOString(),
      })
      if (failures.length > 0) {
        setError(t('health.refreshPartialFailure', 'Some health checks could not be loaded: {{checks}}', {
          checks: failures.join(', '),
        }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleChecks = useMemo(() => (
    SETUP_HEALTH_CHECKS.map((check) => ({
      check,
      status: checkStatus(check.id, snapshot),
    }))
  ), [snapshot])
  const allRuntimeCapabilities = useMemo(() => (
    [...(snapshot.runtimeInputs?.capabilities || [])]
      .sort((left, right) => (
        capabilityStatusPriority(left.status) - capabilityStatusPriority(right.status)
        || left.kind.localeCompare(right.kind)
        || left.id.localeCompare(right.id)
      ))
  ), [snapshot.runtimeInputs])
  const runtimeCapabilities = useMemo(() => allRuntimeCapabilities.slice(0, 12), [allRuntimeCapabilities])
  const runtimeConflicts = snapshot.runtimeInputs?.conflicts || []
  const criticalCapabilities = allRuntimeCapabilities.filter((capability) => capabilityStatusPriority(capability.status) === 0)
  const criticalCapabilityGroups = useMemo(() => {
    const groups = new Map<RuntimeCapabilityProvenanceRecord['kind'], number>()
    for (const capability of allRuntimeCapabilities) {
      if (capabilityStatusPriority(capability.status) !== 0) continue
      groups.set(capability.kind, (groups.get(capability.kind) || 0) + 1)
    }
    return [...groups].map(([kind, count]) => ({
      kind,
      count,
      details: capabilityRecoveryDetails(kind),
    }))
  }, [allRuntimeCapabilities])
  const unhealthyWorkspaces = snapshot.workspaces.filter(({ workspace }) => (
    workspace.status === 'auth_required'
    || workspace.status === 'offline'
    || workspace.status === 'error'
  ))
  const ready = Boolean(
    snapshot.loadedAt
    && snapshot.runtime?.ready
    && criticalCapabilities.length === 0
    && unhealthyWorkspaces.length === 0
    && !error,
  )

  const runWorkspaceAction = async (workspace: WorkspaceInfo) => {
    const action = workspaceAction(workspace)
    if (!action) return
    setBusyAction(`${workspace.id}:${action}`)
    try {
      if (action === 'Sign in') await window.coworkApi.workspace.login(workspace.id)
      else await window.coworkApi.workspace.sync(workspace.id)
      await refresh()
    } catch (err) {
      setError(t('health.operationFailed', 'Health operation failed: {{message}}', {
        message: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setBusyAction(null)
    }
  }

  const restartRuntime = async () => {
    setBusyAction('runtime:restart')
    try {
      await window.coworkApi.runtime.restart()
      await refresh()
    } catch (err) {
      setError(t('health.operationFailed', 'Health operation failed: {{message}}', {
        message: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-base">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-role-page-title font-bold text-text">{t('health.title', 'Health Center')}</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-muted">
              {t(
                'health.subtitle',
                'Check whether Open Cowork is ready, then follow the safest recovery action when something needs attention.',
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            loading={loading}
          >
            {loading ? t('health.refreshing', 'Refreshing...') : t('health.refreshButton', 'Refresh')}
          </Button>
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
            {error}
          </div>
        ) : null}

        <Card className="min-h-[132px]" data-testid="health-summary">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2">
                <StatusPill status={!snapshot.loadedAt ? 'unknown' : ready ? 'ready' : 'action_required'} />
                <h2 className="font-display text-role-card-title font-bold text-text">
                  {!snapshot.loadedAt
                    ? t('health.summaryChecking', 'Checking readiness')
                    : ready
                      ? t('health.summaryReady', 'Open Cowork is ready')
                      : t('health.summaryAction', 'Open Cowork needs attention')}
                </h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {!snapshot.loadedAt
                  ? t('health.summaryCheckingBody', 'Running the core execution and workspace checks now.')
                  : ready
                    ? t('health.summaryReadyBody', 'Execution is available and every connected workspace is reachable.')
                    : t('health.summaryActionBody', 'Resolve the items below before starting important work.')}
              </p>
            </div>
            {!snapshot.runtime?.ready && snapshot.loadedAt ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void restartRuntime()}
                disabled={busyAction === 'runtime:restart'}
                loading={busyAction === 'runtime:restart'}
              >
                {busyAction === 'runtime:restart' ? t('health.restarting', 'Restarting...') : t('health.restartRuntimeButton', 'Restart runtime')}
              </Button>
            ) : null}
          </div>
        </Card>

        {snapshot.loadedAt && (!snapshot.runtime?.ready || unhealthyWorkspaces.length > 0 || criticalCapabilities.length > 0 || error) ? (
          <section aria-labelledby="health-actions-title">
            <h2 id="health-actions-title" className="mb-2 font-display text-role-section-title font-bold text-text">
              {t('health.recoveryActionsTitle', 'What to do next')}
            </h2>
            <div className="grid gap-2 md:grid-cols-2">
              {!snapshot.runtime?.ready ? (
                <Card>
                  <h3 className="text-sm font-semibold text-text">{t('health.runtimeAffected', 'Execution is unavailable')}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">
                    {t('health.runtimeRecovery', 'Restart the runtime. If it remains unavailable, check provider setup in Settings.')}
                  </p>
                </Card>
              ) : null}
              {error ? (
                <Card>
                  <h3 className="text-sm font-semibold text-text">{t('health.checksIncomplete', 'Some checks are incomplete')}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted">
                    {t('health.checksIncompleteRecovery', 'Refresh health checks. If the same check stays unavailable, open Advanced operator diagnostics for its source details.')}
                  </p>
                </Card>
              ) : null}
              {unhealthyWorkspaces.map(({ workspace }) => {
                const action = workspaceAction(workspace)
                return (
                  <Card key={workspace.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-text">{workspace.label}</h3>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">
                          {workspace.status === 'auth_required'
                            ? t('health.workspaceSignInRecovery', 'Sign in again to restore access to this workspace.')
                            : t('health.workspaceSyncRecovery', 'Sync this workspace again. If it stays offline, check its connection.')}
                        </p>
                      </div>
                      {action ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void runWorkspaceAction(workspace)}
                          disabled={busyAction === `${workspace.id}:${action}`}
                          loading={busyAction === `${workspace.id}:${action}`}
                        >
                          {action === 'Sign in' ? t('health.workspaceActionSignIn', 'Sign in') : t('health.workspaceActionSync', 'Sync')}
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                )
              })}
              {criticalCapabilityGroups.map(({ kind, count, details }) => (
                  <Card key={kind}>
                    <h3 className="text-sm font-semibold text-text">
                      {count === 1
                        ? t('health.capabilityAffected', '{{capability}} is unavailable', {
                            capability: details.singular,
                          })
                        : t('health.capabilityClassAffected', '{{count}} {{capabilities}} are unavailable', {
                            count,
                            capabilities: details.plural,
                          })}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-text-muted">
                      {count === 1 ? details.recoverySingular : details.recoveryPlural}
                    </p>
                  </Card>
                ))}
            </div>
          </section>
        ) : null}

        <details
          className="rounded-lg border border-border-subtle bg-elevated/40 p-4"
          data-testid="health-advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-semibold text-text">
            {t('health.advancedTitle', 'Advanced operator diagnostics')}
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            {t('health.advancedDescription', 'Deployment topology, CLI validation commands, runtime provenance, workspace authority, pairings, and operator checks.')}
          </p>
          {advancedOpen ? (
            <div className="mt-4 flex flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-5">
          {SETUP_INTENTS.map((intent) => (
            <Card key={intent.id} className="min-h-[190px]">
              <div className="flex h-full flex-col">
                <div className="text-sm font-semibold text-text">{intent.label}</div>
                <div className="mt-1 text-2xs leading-relaxed text-text-muted">{intent.summary}</div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Badge tone="muted">{intent.topologyProfile}</Badge>
                  <Badge tone="muted">{intent.authority}</Badge>
                </div>
                <div className="mt-auto pt-3 text-2xs leading-relaxed text-text-muted">
                  {intent.validationCommands[0] || intent.primaryDocs}
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_1.3fr]">
          <div className="flex flex-col gap-4">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-role-card-title font-bold text-text">{t('health.desktopRuntimeTitle', 'Desktop Runtime')}</h2>
                  <p className="mt-1 text-2xs text-text-muted">
                    {t('health.desktopRuntimeDescription', 'Local execution authority and provider selection. No raw credential values are shown.')}
                  </p>
                </div>
                <StatusPill status={snapshot.runtime?.ready ? 'ready' : 'action_required'} />
              </div>
              <dl className="mt-3 grid gap-2 text-2xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">{t('health.providerLabel', 'Provider')}</dt>
                  <dd className="truncate text-text-secondary">{snapshot.runtimeInputs?.providerName || snapshot.runtimeInputs?.providerId || t('health.notConfigured', 'not configured')}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">{t('health.modelLabel', 'Model')}</dt>
                  <dd className="truncate text-text-secondary">{snapshot.runtimeInputs?.runtimeModel || snapshot.runtimeInputs?.modelId || t('health.notConfigured', 'not configured')}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">{t('health.credentialKeysLabel', 'Credential keys')}</dt>
                  <dd className="text-text-secondary">{snapshot.runtimeInputs?.credentialOverrideKeys.length ?? 0}</dd>
                </div>
                {snapshot.runtime?.error ? (
                  <div className="rounded border border-red/25 bg-red/10 px-2 py-1 text-red">
                    {snapshot.runtime.error}
                  </div>
                ) : null}
              </dl>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void restartRuntime()}
                disabled={busyAction === 'runtime:restart'}
                loading={busyAction === 'runtime:restart'}
                className="mt-3 self-start"
              >
                {busyAction === 'runtime:restart' ? t('health.restarting', 'Restarting...') : t('health.restartRuntimeButton', 'Restart runtime')}
              </Button>
            </Card>

            <Card>
              <h2 className="font-display text-role-card-title font-bold text-text">{t('health.capabilityProvenanceTitle', 'Runtime Capability Provenance')}</h2>
              <p className="mt-1 text-2xs text-text-muted">{t('health.capabilityProvenanceDescription', 'Source, winner, and reason-code diagnostics for runtime inputs. Evidence is redacted before it reaches the renderer.')}</p>
              <div className="mt-3 flex flex-col gap-2">
                {runtimeCapabilities.length === 0 ? (
                  <div className="rounded border border-border-subtle bg-base px-3 py-2 text-2xs text-text-muted">
                    {t('health.capabilityProvenanceEmpty', 'No runtime capability diagnostics returned.')}
                  </div>
                ) : runtimeCapabilities.map((capability) => {
                  const evidence = Object.entries(capability.evidence || {}).slice(0, 4)
                  return (
                    <div
                      key={`${capability.kind}:${capability.id}:${capability.reasonCode}`}
                      data-testid={`runtime-capability-${capability.kind}-${capability.id}`}
                      className="rounded border border-border-subtle bg-base px-3 py-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-text">{capability.id}</div>
                          <div className="mt-0.5 text-2xs text-text-muted">{capability.kind} · {capability.source} · {capability.productMode}</div>
                        </div>
                        <CapabilityPill status={capability.status} />
                      </div>
                      <div className="mt-2 break-all rounded border border-border-subtle px-2 py-1 font-mono text-2xs text-text-muted">
                        {capability.reasonCode}
                      </div>
                      {evidence.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {evidence.map(([key, value]) => (
                            <span key={key} className="max-w-full truncate rounded border border-border-subtle px-2 py-0.5 text-2xs text-text-muted">
                              {key}: {formatEvidenceValue(value)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              {runtimeConflicts.length > 0 ? (
                <div className="mt-4">
                  <div className="text-2xs font-semibold text-text-secondary">{t('health.conflictsHeading', 'Conflicts')}</div>
                  <div className="mt-2 flex flex-col gap-2">
                    {runtimeConflicts.map((conflict) => (
                      <div key={`${conflict.kind}:${conflict.id}:${conflict.reasonCode}`} className="rounded border border-amber/25 bg-amber/10 px-3 py-2">
                        <div className="text-2xs font-medium text-amber">{conflict.kind}: {conflict.id}</div>
                        <div className="mt-1 text-2xs text-amber/80">
                          {t('health.conflictWinnerLosers', 'winner {{winner}} · losers {{losers}}', { winner: conflict.winnerSource, losers: conflict.loserSources.join(', ') })}
                        </div>
                        <div className="mt-1 break-all font-mono text-2xs text-amber/80">{conflict.reasonCode}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>

            <Card>
              <h2 className="font-display text-role-card-title font-bold text-text">{t('health.pairingsTitle', 'Pairings')}</h2>
              <p className="mt-1 text-2xs text-text-muted">{t('health.pairingsDescription', 'Outbound Desktop pairings stay local-authority unless remote policy explicitly allows more.')}</p>
              <div className="mt-3 flex flex-col gap-2">
                {snapshot.pairings.length === 0 ? (
                  <div className="rounded border border-border-subtle bg-base px-3 py-2 text-2xs text-text-muted">
                    {t('health.pairingsEmpty', 'No pairings configured.')}
                  </div>
                ) : snapshot.pairings.map((pairing) => (
                  <div key={pairing.id} className="rounded border border-border-subtle bg-base px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-xs font-medium text-text">{pairing.label}</div>
                      <Badge tone="neutral" className="shrink-0 capitalize">{pairing.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <div className="mt-1 text-2xs text-text-muted">
                      {t('health.pairingHeartbeatToken', 'Last heartbeat: {{heartbeat}} · token: {{token}}', {
                        heartbeat: pairing.lastHeartbeatAt || t('health.pairingHeartbeatNever', 'never'),
                        token: pairing.credential.hasToken ? t('health.pairingTokenStored', 'stored') : t('health.pairingTokenMissing', 'missing'),
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <h2 className="font-display text-role-card-title font-bold text-text">{t('health.workspacesTitle', 'Workspaces And Authorities')}</h2>
              <p className="mt-1 text-2xs text-text-muted">{t('health.workspacesDescription', 'Each thread must belong to exactly one workspace and one execution authority.')}</p>
              <div className="mt-3 grid gap-2">
                {snapshot.workspaces.length === 0 ? (
                  <div className="rounded border border-border-subtle bg-base px-3 py-2 text-2xs text-text-muted">
                    {t('health.workspacesEmpty', 'No workspaces were returned by the Desktop gateway.')}
                  </div>
                ) : snapshot.workspaces.map(({ workspace, support }) => {
                  const authority = workspaceAuthority(workspace)
                  const contract = workspaceAuthorityContract(authority)
                  const action = workspaceAction(workspace)
                  return (
                    <div key={workspace.id} className="rounded border border-border-subtle bg-base px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-text">{workspace.label}</div>
                          <div className="text-2xs text-text-muted">{authority} · {contract.durableStateOwner}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusPill status={workspace.status} />
                          {action ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void runWorkspaceAction(workspace)}
                              disabled={busyAction === `${workspace.id}:${action}`}
                              loading={busyAction === `${workspace.id}:${action}`}
                            >
                              {busyAction === `${workspace.id}:${action}`
                                ? t('health.workspaceActionWorking', 'Working...')
                                : action === 'Sign in'
                                  ? t('health.workspaceActionSignIn', 'Sign in')
                                  : t('health.workspaceActionSync', 'Sync')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-2xs text-text-muted">
                        <span>{supportSummary(support)}</span>
                        <span>{t('health.workspaceApprovals', 'approvals: {{value}}', { value: contract.defaultApprovals })}</span>
                        <span>{t('health.workspaceQuestions', 'questions: {{value}}', { value: contract.defaultQuestions })}</span>
                        <span>{t('health.workspacePaths', 'paths: {{value}}', { value: contract.defaultPathExposure })}</span>
                      </div>
                      {workspace.error ? (
                        <div className="mt-2 rounded border border-red/25 bg-red/10 px-2 py-1 text-2xs text-red">{workspace.error}</div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card>
              <h2 className="font-display text-role-card-title font-bold text-text">{t('health.operatorChecksTitle', 'Operator Checks')}</h2>
              <p className="mt-1 text-2xs text-text-muted">{t('health.operatorChecksDescription', 'Doctor, smoke, durability, and recovery checks before routing real users or public webhooks.')}</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {visibleChecks.map(({ check, status }) => (
                  <div key={check.id} className="rounded border border-border-subtle bg-base px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-2xs font-medium text-text">{check.label}</div>
                      <StatusPill status={status} />
                    </div>
                    <div className="mt-1 text-2xs leading-relaxed text-text-muted">{check.recoveryAction}</div>
                    <div className="mt-2 truncate text-2xs text-text-muted">{check.docs[0]}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

            </div>
          ) : null}
        </details>

        <div className="rounded-lg border border-border-subtle bg-elevated px-4 py-3 text-2xs text-text-muted">
          {snapshot.loadedAt
            ? t('health.lastRefreshed', 'Last refreshed {{timestamp}}', { timestamp: snapshot.loadedAt })
            : t('health.notLoadedYet', 'Health data has not loaded yet.')}
        </div>
      </div>
    </div>
  )
}
