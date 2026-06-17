import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { asRecord, downloadBlob, errorMessage } from './react-workbench-controller.ts'

type Props = {
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
}

type AdminState = {
  policy: Record<string, unknown> | null
  members: Record<string, unknown>[]
  byok: Record<string, unknown>[]
  tokens: Record<string, unknown>[]
  revealToken: string | null
  agents: Record<string, unknown>[]
  bindings: Record<string, unknown>[]
  deliveries: Record<string, unknown>[]
  billing: Record<string, unknown> | null
  usage: Record<string, unknown>[]
  usageSummary: Record<string, unknown> | null
  audit: Record<string, unknown>[]
  workerPools: Record<string, unknown>[]
  workers: Record<string, unknown>[]
  diagnostics: Record<string, unknown> | null
  error: string | null
}

const EMPTY_STATE: AdminState = {
  policy: null,
  members: [],
  byok: [],
  tokens: [],
  revealToken: null,
  agents: [],
  bindings: [],
  deliveries: [],
  billing: null,
  usage: [],
  usageSummary: null,
  audit: [],
  workerPools: [],
  workers: [],
  diagnostics: null,
  error: null,
}

const SECRET_KEY = /(secret|token|authorization|password|apiKey|signedUrl|downloadUrl|objectKey|storageKey|bucket|container|payload|target|credentialRef|kmsRef|envRef|privateKey|serviceAccount|headers?|cookies?|bearer|jwt|commandLine)/i

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

function canManage(role: unknown) {
  return role === 'owner' || role === 'admin'
}

function canInspectDiagnostics(role: unknown) {
  return canManage(role) || role === 'operator'
}

function rowKey(record: Record<string, unknown>, fallback: string) {
  return text(record.id || record.accountId || record.tokenId || record.providerId || record.agentId || record.bindingId || record.deliveryId || record.poolId || record.workerId, fallback)
}

function pillKind(value: unknown) {
  const valueStatus = String(value || '').toLowerCase()
  if (['active', 'ok', 'ready', 'sent', 'completed', 'enabled'].includes(valueStatus)) return 'ok'
  if (['disabled', 'revoked', 'dead', 'failed', 'error', 'paused', 'invited', 'auth_required', 'pending'].includes(valueStatus)) return 'warn'
  return ''
}

function grantableChannelBindingIds(bindings: Record<string, unknown>[]) {
  return [...new Set(bindings
    .filter((binding) => text(binding.status, 'active') !== 'disabled')
    .map((binding) => text(binding.bindingId || binding.id).trim())
    .filter(Boolean))]
}

function formatDate(value: unknown) {
  if (!value) return 'never'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[redacted]'
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeValue(entry, depth + 1))
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && /(signed\?token=|leaked-secret|sk-|secret:\/\/|gcp-sm:\/\/|aws-sm:\/\/|azure-kv:\/\/|bearer\s+\S+)/i.test(value) ? '[redacted]' : value
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? '[redacted]' : safeValue(entry, depth + 1),
  ]))
}

function downloadJson(filename: string, value: unknown) {
  const redacted = safeValue(value)
  const json = `${JSON.stringify(redacted, null, 2)}\n`
  downloadBlob(new Blob([json], { type: 'application/json' }), filename)
}

function status(message: string, kind: 'ok' | 'warn' = 'ok') {
  for (const id of ['status', 'sidebar-status']) {
    const element = document.getElementById(id)
    if (!element) continue
    element.textContent = message
    element.setAttribute('data-kind', kind)
  }
}

function setGlobalLabels(workspace: unknown, bootstrap: CloudWebClientBootstrap) {
  const record = asRecord(workspace)
  const productName = asRecord(bootstrap.publicBranding).productName || 'Open Cowork Cloud'
  const org = text(record.orgName || record.tenantName || productName)
  const profile = text(record.profileName || bootstrap.profileName || 'default')
  const role = text(record.role || bootstrap.role || 'signed out')
  const email = text(record.email)
  const pairs: Array<[string, string]> = [
    ['org-name', org],
    ['org-meta', record.email ? `${email} - ${role} - ${profile}` : 'Loading workspace'],
    ['profile-name', profile],
    ['role-name', role],
    ['workspace-label', org],
    ['workspace-meta', record.email ? `${email} - ${profile}` : 'Sign in to sync chats'],
    ['profile-summary', profile],
  ]
  for (const [id, value] of pairs) {
    const element = document.getElementById(id)
    if (element) element.textContent = value
  }
  const notice = document.getElementById('admin-notice') as HTMLElement | null
  if (notice) notice.hidden = canManage(role)
}

function Row({ label, value }: { label: unknown, value: unknown }) {
  return <div className="row compact"><strong>{text(label)}</strong><span>{text(value, 'not configured')}</span></div>
}

function Details({ summary, value }: { summary: string, value: unknown }) {
  return <details className="runtime-detail"><summary>{summary}</summary><pre>{JSON.stringify(safeValue(value), null, 2)}</pre></details>
}

function ActionButton({ children, disabled, title, kind = '', onClick }: { children: string, disabled?: boolean, title?: string, kind?: string, onClick: () => void }) {
  return <button type="button" className={kind} disabled={disabled} title={disabled ? title : ''} onClick={onClick}>{children}</button>
}

function AdminRows({ rows }: { rows: Array<[unknown, unknown]> }) {
  return <>{rows.map(([label, value]) => <Row key={text(label)} label={label} value={value} />)}</>
}

function providerSettingsFromForm(data: FormData) {
  const provider = text(data.get('provider')).trim()
  const pick = (key: string) => text(data.get(key)).trim()
  if (provider === 'slack') return { teamId: pick('slackTeamId'), defaultChannelId: pick('slackChannelId'), apiBaseUrl: pick('slackApiBaseUrl') }
  if (provider === 'email') return { inboundAddress: pick('emailAddress'), domain: pick('emailDomain'), smtpHost: pick('emailSmtpHost') }
  if (provider === 'webhook') return { deliveryUrl: pick('webhookDeliveryUrl') }
  return {}
}

export function CloudAdminSurfacePortals({ bootstrap, workspace }: Props) {
  const api = useAppApi()
  const workspaceRecord = asRecord(workspace)
  const role = workspaceRecord.role || (workspaceRecord.email ? bootstrap.role : 'signed-out')
  const locked = !canManage(role)
  const diagnosticsLocked = !canInspectDiagnostics(role)
  const lockTitle = 'This action requires an org owner or admin role.'
  const diagnosticsLockTitle = 'Diagnostics require an org owner, admin, or operator role.'
  const [state, setState] = useState<AdminState>(EMPTY_STATE)
  const [memberFilter, setMemberFilter] = useState('')
  const [auditFilter, setAuditFilter] = useState('')
  // The most recent issued invite — surfaced so the admin can copy + share the (single-use,
  // expiring) invite token. The invitee accepts it via POST /api/invites/accept.
  const [lastInvite, setLastInvite] = useState<{ email: string, token: string } | null>(null)

  const targets = {
    members: usePortalTarget('member-list'), memberCount: usePortalTarget('member-count'), inviteNotice: usePortalTarget('member-invite-notice'),
    policy: usePortalTarget('admin-policy-overview'), features: usePortalTarget('admin-policy-features'), project: usePortalTarget('admin-project-policy'), runtime: usePortalTarget('admin-runtime-policy'), workers: usePortalTarget('admin-worker-summary'),
    byok: usePortalTarget('byok-list'), byokNote: usePortalTarget('byok-policy-note'), tokens: usePortalTarget('token-list'), agents: usePortalTarget('agent-list'), bindingSelect: usePortalTarget('binding-agent'), bindings: usePortalTarget('binding-list'), deliveries: usePortalTarget('delivery-list'), setup: usePortalTarget('gateway-setup-guide'),
    billing: usePortalTarget('billing-summary'), planSelect: usePortalTarget('billing-plan-select'), entitlements: usePortalTarget('billing-entitlements'), audit: usePortalTarget('audit-list'), auditCount: usePortalTarget('audit-count'),
    quotas: usePortalTarget('usage-quota-list'), totals: usePortalTarget('usage-total-list'), usage: usePortalTarget('usage-list'), diagnosticsHealth: usePortalTarget('diagnostics-health'), diagnosticsBundle: usePortalTarget('diagnostics-bundle'),
  }
  const signupMode = text(asRecord(state.policy?.signup).mode, 'loading')
  const inviteDisabled = locked || signupMode !== 'invite'
  const inviteDisabledReason = locked
    ? lockTitle
    : signupMode === 'loading'
      ? 'Invite policy is loading.'
      : 'Member invites are available only when signup mode is invite.'
  const memberMutationDisabled = locked || signupMode !== 'invite'
  const billingDisabled = state.billing?.enabled === false
  const billingActionDisabled = state.billing === null || billingDisabled
  const billingDisabledReason = state.billing === null ? 'Billing state is loading.' : 'Billing is not available for this deployment.'

  const reload = useCallback(async (options: { preserveRevealToken?: boolean } = {}) => {
    const preserveRevealToken = options.preserveRevealToken === true
    if (!preserveRevealToken) {
      setState((current) => current.revealToken ? ({ ...current, revealToken: null }) : current)
    }
    try {
      const loadAdmin = !locked
      const loadSignedInSummary = text(role, 'signed-out') !== 'signed-out'
      const [
        policy, byok, tokens, billing, usage, usageSummary, agents, bindings, deliveries,
        members, audit, workerPools, workers,
      ] = await Promise.all([
        loadSignedInSummary ? api.admin.policy().then((body) => asRecord(body).policy || null).catch(() => null) : Promise.resolve(null),
        loadAdmin ? api.admin.byok.list().then((body) => list<Record<string, unknown>>(asRecord(body).secrets)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.apiTokens.list().then((body) => list<Record<string, unknown>>(asRecord(body).tokens)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.billing.subscription().then(asRecord).catch(() => ({ enabled: false })) : Promise.resolve(null),
        loadSignedInSummary ? api.admin.usage.events().then((body) => list<Record<string, unknown>>(asRecord(body).events)).catch(() => []) : Promise.resolve([]),
        loadSignedInSummary ? api.admin.usage.summary().then(asRecord).catch(() => null) : Promise.resolve(null),
        loadAdmin ? api.admin.channels.agents().then((body) => list<Record<string, unknown>>(asRecord(body).agents)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.channels.bindings().then((body) => list<Record<string, unknown>>(asRecord(body).bindings)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.channels.deliveries().then((body) => list<Record<string, unknown>>(asRecord(body).deliveries).map((entry) => safeValue(entry) as Record<string, unknown>)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.members.list().then((body) => list<Record<string, unknown>>(asRecord(body).members)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.audit().then((body) => list<Record<string, unknown>>(asRecord(body).events).map((entry) => safeValue(entry) as Record<string, unknown>)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.workerPools().then((body) => list<Record<string, unknown>>(asRecord(body).pools)).catch(() => []) : Promise.resolve([]),
        loadAdmin ? api.admin.workers().then((body) => list<Record<string, unknown>>(asRecord(body).workers)).catch(() => []) : Promise.resolve([]),
      ])
      setState((current) => ({ ...current, policy: policy ? asRecord(policy) : null, byok, tokens, billing: billing ? asRecord(billing) : null, usage, usageSummary, agents, bindings, deliveries, members, audit, workerPools, workers, revealToken: preserveRevealToken ? current.revealToken : null, error: null }))
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error) }))
    }
  }, [api, locked, role])

  const mutate = useCallback(async (message: string, action: () => Promise<unknown>) => {
    try {
      await action()
      await reload()
      status(message, 'ok')
    } catch (error) {
      status(errorMessage(error), 'warn')
    }
  }, [reload])

  const revealOneTimeToken = useCallback((value: unknown) => {
    const token = text(value).trim()
    if (!token) return false
    setState((current) => ({ ...current, revealToken: token }))
    return true
  }, [])

  const issueApiToken = useCallback(async (message: string, input: Record<string, unknown>) => {
    try {
      const issued = asRecord(await api.admin.apiTokens.create(input))
      const revealed = revealOneTimeToken(issued.plaintext)
      await reload({ preserveRevealToken: revealed })
      if (!revealed) throw new Error('Token was created, but the API did not return one-time plaintext.')
      status(message, 'ok')
      return true
    } catch (error) {
      status(errorMessage(error), 'warn')
      return false
    }
  }, [api, reload, revealOneTimeToken])

  useEffect(() => {
    document.body.dataset.reactAdminSurfaces = 'active'
    setGlobalLabels(workspace, bootstrap)
    void reload()
    return () => {
      delete document.body.dataset.reactAdminSurfaces
    }
  }, [bootstrap, reload, workspace])

  useEffect(() => {
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('[data-admin-control="true"]'))
    for (const control of controls) {
      const routeId = control.closest<HTMLElement>('[data-route-panel]')?.dataset.routePanel
      const routeReason = bootstrap.adminSurfaces.find((surface) => surface.routeId === routeId)?.disabledReason
      const isInviteControl = Boolean(control.closest('#member-invite-form'))
      const isBillingControl = control.dataset.billingControl === 'true'
      const routeLocked = routeId === 'diagnostics' ? diagnosticsLocked : locked
      const disabled = routeLocked || (isInviteControl && inviteDisabled) || (isBillingControl && billingActionDisabled)
      control.disabled = disabled
      control.dataset.locked = disabled ? 'true' : 'false'
      if (disabled) control.title = routeId === 'diagnostics' ? diagnosticsLockTitle : isBillingControl ? billingDisabledReason : isInviteControl ? inviteDisabledReason : routeReason || lockTitle
      else control.removeAttribute('title')
    }
    const member = document.getElementById('member-filter') as HTMLInputElement | null
    const audit = document.getElementById('audit-filter') as HTMLInputElement | null
    const onMember = () => setMemberFilter(member?.value || '')
    const onAudit = () => setAuditFilter(audit?.value || '')
    member?.addEventListener('input', onMember)
    audit?.addEventListener('input', onAudit)
    return () => {
      member?.removeEventListener('input', onMember)
      audit?.removeEventListener('input', onAudit)
    }
  }, [billingActionDisabled, billingDisabledReason, bootstrap.adminSurfaces, diagnosticsLocked, diagnosticsLockTitle, inviteDisabled, inviteDisabledReason, locked, lockTitle])

  const filteredMembers = useMemo(() => {
    const query = memberFilter.toLowerCase().trim()
    return query ? state.members.filter((member) => [member.email, member.role, member.status].join(' ').toLowerCase().includes(query)) : state.members
  }, [memberFilter, state.members])
  const filteredAudit = useMemo(() => {
    const query = auditFilter.toLowerCase().trim()
    return query ? state.audit.filter((event) => JSON.stringify(event).toLowerCase().includes(query)) : state.audit
  }, [auditFilter, state.audit])

  useEffect(() => {
    const bindForm = (id: string, handler: (data: FormData, form: HTMLFormElement) => Promise<void>) => {
      const form = document.getElementById(id) as HTMLFormElement | null
      if (!form) return undefined
      const listener = (event: SubmitEvent) => {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        if (id === 'member-invite-form' && inviteDisabled) return status(inviteDisabledReason, 'warn')
        if (id === 'billing-form' && billingActionDisabled) return status(billingDisabledReason, 'warn')
        void mutate('Action complete', async () => {
          await handler(new FormData(form), form)
          form.reset()
        })
      }
      form.addEventListener('submit', listener, true)
      return () => form.removeEventListener('submit', listener, true)
    }
    const disposers = [
      bindForm('member-invite-form', (data) => {
        const email = text(data.get('email')).trim()
        return api.admin.members.invite({ email, role: text(data.get('role'), 'member') }).then((body) => {
          const token = text(asRecord(body).inviteToken)
          setLastInvite(token ? { email, token } : null)
        })
      }),
      bindForm('byok-form', (data) => {
        const providerId = text(data.get('providerId')).trim().toLowerCase()
        const apiKey = text(data.get('apiKey')).trim()
        const kmsRef = text(data.get('kmsRef')).trim()
        if (!providerId || (!apiKey && !kmsRef)) throw new Error('Provider and credential are required.')
        if (apiKey && kmsRef) throw new Error('Use either an API key or a KMS ref, not both.')
        return api.admin.byok.save(providerId, apiKey ? { apiKey } : { kmsRef }).then(() => undefined)
      }),
      bindForm('agent-form', (data) => api.admin.channels.createAgent({ name: text(data.get('name')).trim(), profileName: text(data.get('profileName') || asRecord(workspace).profileName || bootstrap.profileName, 'default'), status: 'active', managed: true }).then(() => undefined)),
      bindForm('binding-form', (data) => api.admin.channels.createBinding({ agentId: text(data.get('agentId')).trim(), provider: text(data.get('provider')).trim(), displayName: text(data.get('displayName')).trim(), externalWorkspaceId: text(data.get('externalWorkspaceId') || data.get('slackTeamId') || data.get('emailDomain')).trim() || null, credentialRef: text(data.get('credentialRef')).trim() || null, status: 'auth_required', settings: Object.fromEntries(Object.entries(providerSettingsFromForm(data)).filter(([, value]) => Boolean(value))) }).then(() => undefined)),
      bindForm('billing-form', async (data) => { const result = asRecord(await api.admin.billing.checkout({ planKey: text(data.get('planKey')).trim() || null })); if (result.url) window.location.href = text(result.url) }),
    ].filter(Boolean) as Array<() => void>
    const tokenForm = document.getElementById('token-form') as HTMLFormElement | null
    const tokenListener = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (locked) return status(lockTitle, 'warn')
      if (!tokenForm) return
      const data = new FormData(tokenForm)
      const scopes = Array.from(tokenForm.querySelectorAll<HTMLInputElement>('input[name="scopes"]:checked')).map((input) => input.value)
      void issueApiToken('Token issued', { name: text(data.get('name')).trim(), scopes }).then((ok) => { if (ok) tokenForm.reset() })
    }
    tokenForm?.addEventListener('submit', tokenListener, true)
    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('#refresh-admin') || target.closest('#refresh-gateway')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        void reload()
      } else if (target.closest('#desktop-token')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        void issueApiToken('Desktop token issued', { name: 'Desktop connection', scopes: ['desktop'] })
      } else if (target.closest('#gateway-token')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        void (async () => {
          const channelBindingIds = grantableChannelBindingIds(state.bindings)
          if (channelBindingIds.length === 0) return status('Create a channel binding before issuing a Gateway token.', 'warn')
          await issueApiToken('Gateway token issued', { name: 'Gateway service token', scopes: ['gateway'], channelBindingIds })
        })()
      } else if (target.closest('#billing-portal')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        if (billingActionDisabled) status(billingDisabledReason, 'warn'); else void mutate('Billing portal opened', async () => { const result = asRecord(await api.admin.billing.portal()); if (result.url) window.location.href = text(result.url) })
      } else if (target.closest('#export-audit')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (locked) return status(lockTitle, 'warn')
        downloadJson('open-cowork-audit-events.json', { exportedAt: new Date().toISOString(), filter: auditFilter || null, events: filteredAudit })
      } else if (target.closest('#export-usage')) {
        event.preventDefault(); event.stopImmediatePropagation(); downloadJson('open-cowork-usage.json', { exportedAt: new Date().toISOString(), summary: state.usageSummary, events: state.usage })
      } else if (target.closest('#prepare-diagnostics')) {
        event.preventDefault(); event.stopImmediatePropagation()
        if (diagnosticsLocked) return status(diagnosticsLockTitle, 'warn')
        void mutate('Diagnostics prepared', async () => { const diagnostics = safeValue(await api.admin.diagnostics()) as Record<string, unknown>; setState((current) => ({ ...current, diagnostics })) })
      }
    }
    document.addEventListener('click', click, true)
    return () => {
      disposers.forEach((dispose) => dispose())
      tokenForm?.removeEventListener('submit', tokenListener, true)
      document.removeEventListener('click', click, true)
    }
  }, [api, auditFilter, billingActionDisabled, billingDisabledReason, bootstrap.profileName, diagnosticsLocked, diagnosticsLockTitle, filteredAudit, inviteDisabled, inviteDisabledReason, issueApiToken, locked, lockTitle, mutate, reload, state.bindings, state.usage, state.usageSummary, workspace])

  const portals = []
  if (targets.memberCount) portals.push(createPortal(<>{filteredMembers.length}</>, targets.memberCount))
  if (targets.inviteNotice) portals.push(createPortal(
    lastInvite
      ? <>Invite created for {lastInvite.email}. Share this single-use invite token (expires in 7 days): <code className="invite-token" data-cloud-invite-token>{lastInvite.token}</code></>
      : <>{inviteDisabled ? inviteDisabledReason : 'Invite mode is enabled. Invited users activate on first verified sign-in.'}</>,
    targets.inviteNotice,
  ))
  if (targets.members) portals.push(createPortal(<>{filteredMembers.length ? filteredMembers.slice(0, 100).map((member, index) => {
    const id = rowKey(member, `member-${index}`)
    const roleMutationDisabled = memberMutationDisabled || member.status === 'disabled'
    return <div className="table-row member-row" role="row" key={id}><span role="cell">{[member.email, member.displayName].filter(Boolean).join(' - ')}</span><span role="cell"><span className="pill" data-kind={member.role === 'owner' ? 'ok' : ''}>{text(member.role, 'member')}</span></span><span role="cell"><span className="pill" data-kind={pillKind(member.status)}>{text(member.status, 'unknown')}</span></span><span role="cell" className="row-actions"><ActionButton disabled={roleMutationDisabled || member.role === 'admin'} title={memberMutationDisabled ? inviteDisabledReason : lockTitle} onClick={() => void mutate('Member updated', () => api.admin.members.update(id, { role: 'admin' }))}>Make admin</ActionButton><ActionButton disabled={roleMutationDisabled || member.role === 'member'} title={memberMutationDisabled ? inviteDisabledReason : lockTitle} onClick={() => void mutate('Member updated', () => api.admin.members.update(id, { role: 'member' }))}>Make member</ActionButton><ActionButton kind="danger" disabled={memberMutationDisabled || member.status === 'disabled'} title={memberMutationDisabled ? inviteDisabledReason : lockTitle} onClick={() => { if (window.prompt(`Type the account id to confirm member suspension or invite revocation: ${id}`) === id) void mutate('Member disabled', () => api.admin.members.update(id, { status: 'disabled', confirm: id })); else status('Confirmation did not match the account id.', 'warn') }}>Suspend</ActionButton></span></div>
  }) : <div className="table-row empty-row" role="row"><span role="cell">{state.error || 'No member records loaded.'}</span><span role="cell">-</span><span role="cell">-</span><span role="cell">-</span></div>}</>, targets.members))

  if (targets.policy) portals.push(createPortal(state.policy ? <AdminRows rows={[['Org', asRecord(state.policy.org).name || asRecord(state.policy.org).orgId], ['Signup mode', asRecord(state.policy.signup).mode], ['Profile', [asRecord(state.policy.profile).name, asRecord(state.policy.profile).label].filter(Boolean).join(' - ')], ['Allowed agents', list(state.policy.allowedAgents).join(', ') || 'profile defaults'], ['Allowed tools', list(state.policy.allowedTools).join(', ') || 'profile defaults'], ['Allowed MCPs', list(state.policy.allowedMcps).join(', ') || 'profile defaults']]} /> : <p className="empty">No policy loaded.</p>, targets.policy))
  if (targets.features) portals.push(createPortal(<>{Object.entries(asRecord(state.policy?.features || bootstrap.features)).sort().map(([key, value]) => <Row key={key} label={key} value={value ? 'enabled' : 'disabled'} />)}</>, targets.features))
  if (targets.project) portals.push(createPortal(<Details summary="Project source policy" value={asRecord(state.policy?.projectSources)} />, targets.project))
  if (targets.runtime) portals.push(createPortal(<><Details summary="Runtime policy" value={asRecord(state.policy?.runtime)} /><Details summary="Gateway policy" value={asRecord(state.policy?.gateway)} /></>, targets.runtime))
  if (targets.workers) portals.push(createPortal(<><Row label="Org worker capacity" value={`${state.workerPools.length} pool(s), ${state.workers.filter((worker) => worker.status === 'active').length} active worker(s)`} />{state.workerPools.slice(0, 4).map((pool, index) => <Row key={rowKey(pool, `pool-${index}`)} label={pool.name || pool.poolId} value={`${pool.mode || 'pool'} - ${pool.status || 'unknown'}`} />)}{state.workers.slice(0, 6).map((worker, index) => <Row key={rowKey(worker, `worker-${index}`)} label={worker.displayName || worker.name || worker.workerId} value={`${worker.status || 'unknown'} - load ${worker.currentLoad ?? 0}`} />)}</>, targets.workers))

  if (targets.byokNote) portals.push(createPortal(<>{`Allowed providers: ${list(asRecord(state.policy?.byok).allowedProviderIds).join(', ') || 'profile defaults'} - ${asRecord(state.policy?.byok).kmsRefsEnabled ? 'KMS refs enabled' : 'KMS refs disabled'}`}</>, targets.byokNote))
  if (targets.byok) portals.push(createPortal(<>{state.byok.length ? state.byok.map((secret, index) => { const id = rowKey(secret, `secret-${index}`); return <div className="row" key={id}><div><strong>{id}</strong> {secret.credentialKind === 'kms_ref' ? 'KMS ref' : 'key'} ending {text(secret.last4)}<br /><small>Updated {formatDate(secret.updatedAt)} - {secret.lastValidatedAt ? `validated ${formatDate(secret.lastValidatedAt)}` : 'not validated'}</small></div><div className="row-actions"><span className="pill" data-kind={pillKind(secret.status)}>{text(secret.status, 'unknown')}</span><ActionButton disabled={locked} title={lockTitle} onClick={() => void mutate('Provider validated', () => api.admin.byok.validate(id))}>Validate</ActionButton>{secret.status !== 'active' ? <ActionButton disabled={locked} title={lockTitle} onClick={() => { const reason = window.prompt(`Activate ${id} without validation? Enter an audit reason (recorded in the audit log):`); if (reason && reason.trim()) void mutate('Provider activated', () => api.admin.byok.override(id, reason.trim())); else if (reason !== null) status('An audit reason is required to override validation.', 'warn') }}>Activate</ActionButton> : null}<ActionButton kind="danger" disabled={locked} title={lockTitle} onClick={() => { if (window.prompt(`Type the provider id to confirm BYOK credential disablement: ${id}`) === id) void mutate('Provider disabled', () => api.admin.byok.disable(id)); else status('Confirmation did not match the provider id.', 'warn') }}>Disable</ActionButton></div></div> }) : <p className="empty">No provider keys configured.</p>}</>, targets.byok))
  if (targets.tokens) portals.push(createPortal(<>{state.revealToken ? <div className="secret-reveal"><label>New token<input readOnly value={state.revealToken} /></label><small>Shown once. It is not stored by this dashboard.</small><div className="row-actions"><button type="button" onClick={() => setState((current) => ({ ...current, revealToken: null }))}>Clear token</button></div></div> : null}{state.tokens.length ? state.tokens.slice(0, 100).map((token, index) => { const id = rowKey(token, `token-${index}`); return <div className="row" key={id}><div><strong>{text(token.name, 'API token')}</strong> ending {text(token.last4)}<br /><small>{list(token.scopes).join(', ') || 'scoped'} - last used {formatDate(token.lastUsedAt)}</small></div><div className="row-actions"><span className="pill" data-kind={token.revokedAt ? 'warn' : 'ok'}>{token.revokedAt ? 'revoked' : 'active'}</span>{!token.revokedAt ? <ActionButton kind="danger" disabled={locked} title={lockTitle} onClick={() => { if (window.prompt(`Type the token id to confirm token revocation: ${id}`) === id) void mutate('Token revoked', () => api.admin.apiTokens.revoke(id)); else status('Confirmation did not match the token id.', 'warn') }}>Revoke</ActionButton> : null}</div></div> }) : <p className="empty">No API tokens issued.</p>}</>, targets.tokens))

  if (targets.setup) portals.push(createPortal(<>{['Create or rotate a gateway-scoped service token in Connections.', 'Deploy the gateway with OPEN_COWORK_CLOUD_BASE_URL and OPEN_COWORK_GATEWAY_SERVICE_TOKEN.', 'Use the delivery backlog below to retry or dead-letter stuck outbound messages.'].map((step, index) => <div className="row compact" key={step}><span className="pill">{index + 1}</span><span>{step}</span></div>)}</>, targets.setup))
  if (targets.bindingSelect) portals.push(createPortal(<>{state.agents.map((agent, index) => <option key={rowKey(agent, `agent-${index}`)} value={text(agent.agentId)}>{text(agent.name)}</option>)}</>, targets.bindingSelect))
  if (targets.agents) portals.push(createPortal(<>{state.agents.length ? state.agents.map((agent, index) => <div className="row" key={rowKey(agent, `agent-${index}`)}><div><strong>{text(agent.name, 'Agent')}</strong> - {text(agent.profileName, 'default')}</div><span className="pill" data-kind={pillKind(agent.status)}>{text(agent.status, 'unknown')}</span></div>) : <p className="empty">No headless agents configured.</p>}</>, targets.agents))
  if (targets.bindings) portals.push(createPortal(<>{state.bindings.length ? state.bindings.map((binding, index) => <div className="row" key={rowKey(binding, `binding-${index}`)}><div><strong>{text(binding.displayName, 'Binding')}</strong> - {text(binding.provider)}<br /><small>{[binding.externalWorkspaceId || 'tenant-wide channel', JSON.stringify(safeValue(binding.settings || {}))].filter(Boolean).join(' - ')}</small></div><span className="pill" data-kind={pillKind(binding.status)}>{text(binding.status, 'unknown')}</span></div>) : <p className="empty">No channel bindings configured.</p>}</>, targets.bindings))
  if (targets.deliveries) portals.push(createPortal(<>{state.deliveries.length ? state.deliveries.slice(0, 50).map((delivery, index) => { const id = rowKey(delivery, `delivery-${index}`); return <div className="row" key={id}><div><strong>{text(delivery.eventType || delivery.deliveryId, 'delivery')}</strong><br /><small>{[delivery.provider, delivery.channelBindingId, `attempts ${delivery.attemptCount || 0}`, delivery.lastError, `next ${formatDate(delivery.nextAttemptAt)}`].filter(Boolean).join(' - ')}</small></div><div className="row-actions"><span className="pill" data-kind={pillKind(delivery.status)}>{text(delivery.status, 'unknown')}</span><ActionButton disabled={locked || delivery.status === 'sent'} title={lockTitle} onClick={() => void mutate('Delivery retried', () => api.admin.channels.retryDelivery(id))}>Retry</ActionButton><ActionButton kind="danger" disabled={locked || delivery.status === 'dead'} title={lockTitle} onClick={() => { if (window.prompt(`Type the delivery id to confirm dead-lettering: ${id}`) === id) { const lastError = window.prompt('Reason for dead-lettering this delivery.') || ''; void mutate('Delivery dead-lettered', () => api.admin.channels.deadLetterDelivery(id, { lastError })) } else status('Confirmation did not match the delivery id.', 'warn') }}>Dead-letter</ActionButton></div><Details summary="Redacted delivery payload" value={delivery} /></div> }) : <p className="empty">No gateway deliveries loaded.</p>}</>, targets.deliveries))

  if (targets.billing) portals.push(createPortal(billingDisabled ? <><span className="pill" data-kind="warn">billing disabled</span><p className="empty">Self-host mode is active.</p></> : <><span className="pill" data-kind={state.billing?.active ? 'ok' : 'warn'}>{state.billing?.active ? 'active' : 'action required'}</span><span className="pill">{text(state.billing?.mode, 'managed')}</span><p>{state.billing?.subscription ? `${text(asRecord(state.billing.subscription).planKey)} - ${text(asRecord(state.billing.subscription).status)} - ${text(asRecord(state.billing.subscription).seats)} seat(s)` : 'No subscription is attached to this org.'}</p></>, targets.billing))
  if (targets.planSelect) portals.push(createPortal(<>{list<Record<string, unknown>>(state.billing?.plans).map((plan) => <option key={text(plan.planKey)} value={text(plan.planKey)}>{text(plan.label)}{plan.default ? ' (default)' : ''}</option>)}</>, targets.planSelect))
  if (targets.entitlements) portals.push(createPortal(<>{list<Record<string, unknown>>(state.billing?.plans).length ? list<Record<string, unknown>>(state.billing?.plans).map((plan) => <div className="row compact" key={text(plan.planKey)}><strong>{text(plan.label || plan.planKey)}</strong><span className="pill">{plan.default ? 'default' : 'available'}</span><Details summary="Entitlements" value={plan.entitlements || {}} /></div>) : <Details summary="Resolved entitlements" value={state.billing?.entitlements || {}} />}</>, targets.entitlements))
  if (targets.auditCount) portals.push(createPortal(<>{filteredAudit.length}</>, targets.auditCount))
  if (targets.audit) portals.push(createPortal(<>{filteredAudit.length ? filteredAudit.slice(0, 100).map((event, index) => <div className="row" key={rowKey(event, `audit-${index}`)}><div><strong>{text(event.action || event.eventType, 'audit event')}</strong><br /><small>{[event.actorEmail || event.actorId, event.entityType || event.targetType, formatDate(event.createdAt)].filter(Boolean).join(' - ')}</small></div><Details summary="Redacted metadata" value={event.metadata || event} /></div>) : <p className="empty">No audit events loaded.</p>}</>, targets.audit))
  if (targets.quotas) portals.push(createPortal(<>{list<Record<string, unknown>>(state.usageSummary?.quotas).map((quota) => <div className="row compact" key={text(quota.quotaKey)}><strong>{text(quota.label || quota.quotaKey)}</strong><span>{quota.enabled ? `${text(quota.used)} of ${text(quota.limit)} ${text(quota.unit)} - resets ${formatDate(quota.resetAt)}` : 'unlimited or disabled'}</span></div>)}</>, targets.quotas))
  if (targets.totals) portals.push(createPortal(<><p className="empty">Recent totals from the latest {text(state.usageSummary?.eventSampleLimit, '100')} usage events.</p>{list<Record<string, unknown>>(state.usageSummary?.totals).map((total) => <Row key={text(total.eventType)} label={total.eventType} value={`${text(total.quantity)} ${text(total.unit)}`} />)}</>, targets.totals))
  if (targets.usage) portals.push(createPortal(<>{state.usage.length ? state.usage.slice(0, 12).map((event, index) => <div className="row compact" key={rowKey(event, `usage-${index}`)}><strong>{text(event.eventType)}</strong><span>{text(event.quantity)} {text(event.unit)} - {formatDate(event.createdAt)}</span></div>) : <p className="empty">No usage events recorded yet.</p>}</>, targets.usage))
  if (targets.diagnosticsHealth) portals.push(createPortal(state.diagnostics ? <AdminRows rows={[['Generated', formatDate(state.diagnostics.generatedAt)], ['Redaction', state.diagnostics.redaction || 'secrets-redacted'], ['Runtime role', asRecord(state.diagnostics.runtime).role || 'unknown'], ['Command processing', asRecord(state.diagnostics.runtime).commandProcessing || 'unknown'], ['Worker heartbeats', asRecord(state.diagnostics.runtime).heartbeatCount ?? 0], ['Gateway agents', asRecord(asRecord(state.diagnostics.gateway).agents).total ?? 0]]} /> : <p className="empty">No diagnostics loaded.</p>, targets.diagnosticsHealth))
  if (targets.diagnosticsBundle) portals.push(createPortal(state.diagnostics ? <><Details summary="Redacted diagnostics JSON" value={state.diagnostics} /><div className="row-actions"><ActionButton kind="primary" onClick={() => downloadJson('open-cowork-diagnostics.json', state.diagnostics)}>Download bundle</ActionButton></div></> : <p className="empty">Prepare a bundle to inspect redacted support data.</p>, targets.diagnosticsBundle))
  return <>{portals}</>
}
