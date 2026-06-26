import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SETUP_HEALTH_CHECKS,
  SETUP_INTENTS,
  workspaceAuthorityContract,
  type DesktopPairingPublicRecord,
  type RuntimeCapabilityStatus,
  type RuntimeInputDiagnostics,
  type RuntimeStatus,
  type SetupHealthStatus,
  type WorkspaceApiSupport,
  type WorkspaceExecutionAuthority,
  type WorkspaceInfo,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, type BadgeTone } from '../ui'

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

function StatusPill({ status }: { status: SetupHealthStatus | WorkspaceInfo['status'] }) {
  return (
    <Badge tone={statusBadgeTone(status)} className="shrink-0 capitalize">
      {statusLabel(status)}
    </Badge>
  )
}

function CapabilityPill({ status }: { status: RuntimeCapabilityStatus }) {
  return (
    <Badge tone={capabilityBadgeTone(status)} className="shrink-0 capitalize">
      {status.replace(/-/g, ' ')}
    </Badge>
  )
}

export function HealthCenterPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>(INITIAL_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [runtime, runtimeInputs, workspaces, pairings] = await Promise.all([
        window.coworkApi.runtime.status().catch(() => null),
        window.coworkApi.app.runtimeInputs().catch(() => null),
        window.coworkApi.workspace.list().catch(() => []),
        window.coworkApi.desktopPairing.list().catch(() => []),
      ])
      const workspaceHealth = await Promise.all((workspaces || []).map(async (workspace) => ({
        workspace,
        support: await window.coworkApi.workspace.support(workspace.id).catch(() => []),
      })))
      setSnapshot({
        runtime,
        runtimeInputs,
        workspaces: workspaceHealth,
        pairings,
        loadedAt: new Date().toISOString(),
      })
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
  const runtimeCapabilities = useMemo(() => (
    [...(snapshot.runtimeInputs?.capabilities || [])]
      .sort((left, right) => (
        capabilityStatusPriority(left.status) - capabilityStatusPriority(right.status)
        || left.kind.localeCompare(right.kind)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, 12)
  ), [snapshot.runtimeInputs])
  const runtimeConflicts = snapshot.runtimeInputs?.conflicts || []

  const runWorkspaceAction = async (workspace: WorkspaceInfo) => {
    const action = workspaceAction(workspace)
    if (!action) return
    setBusyAction(`${workspace.id}:${action}`)
    try {
      if (action === 'Sign in') await window.coworkApi.workspace.login(workspace.id)
      else await window.coworkApi.workspace.sync(workspace.id)
      await refresh()
    } finally {
      setBusyAction(null)
    }
  }

  const restartRuntime = async () => {
    setBusyAction('runtime:restart')
    try {
      await window.coworkApi.runtime.restart()
      await refresh()
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
              {t('health.subtitle', 'Setup paths, execution authority, sync state, and operator recovery checks for Desktop, Cloud, and Gateway.')}
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

        <div className="rounded-lg border border-border-subtle bg-elevated px-4 py-3 text-2xs text-text-muted">
          {snapshot.loadedAt
            ? t('health.lastRefreshed', 'Last refreshed {{timestamp}}', { timestamp: snapshot.loadedAt })
            : t('health.notLoadedYet', 'Health data has not loaded yet.')}
        </div>
      </div>
    </div>
  )
}
