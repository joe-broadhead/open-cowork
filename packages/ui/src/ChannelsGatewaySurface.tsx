import {
  type ComponentPropsWithoutRef,
  type FormEvent,
  useMemo,
  useState,
} from 'react'
import {
  buildChannelProviderStatuses,
  channelProviderKindFromId,
  channelProviderLabel,
  type ChannelAgentRecord,
  type ChannelBindingPublicRecord,
  type ChannelDeliveryPublicRecord,
  type ChannelIdentityPublicRecord,
  type ChannelIdentityRole,
  type ChannelPersonResolveInput,
  type ChannelProviderKind,
  type ChannelProviderStatus,
  type CoordinationWatch,
  type CoordinationWatchEventType,
  type CoordinationWatchInput,
  type CoordinationWatchRecipientRole,
  type CoordinationWatchTarget,
} from '@open-cowork/shared'
import { Badge, type BadgeTone } from './Badge.js'
import { Button } from './Button.js'
import { EmptyState } from './EmptyState.js'
import { Icon } from './Icon.js'
import { CoworkerAvatar, StudioPageHeader } from './StudioPrimitives.js'
import { cn } from './utils.js'

const DISPLAY_PROVIDER_ORDER: ChannelProviderKind[] = [
  'whatsapp',
  'telegram',
  'slack',
  'discord',
  'signal',
  'email',
  'webhook',
]

const CHANNEL_ROLE_ORDER: ChannelIdentityRole[] = ['owner', 'admin', 'member', 'approver', 'viewer']
const WATCH_EVENT_ORDER: CoordinationWatchEventType[] = ['task.moved', 'task.review_ready', 'run.finished', 'needs_input', 'daily_summary']
const WATCH_TARGET_ORDER: CoordinationWatchTarget[] = ['project', 'conversation']

const ROLE_LABELS: Record<ChannelIdentityRole | CoordinationWatchRecipientRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  approver: 'Approver',
  viewer: 'Viewer',
}

const ROLE_DESCRIPTIONS: Record<ChannelIdentityRole, string> = {
  owner: 'Full channel ownership and setup authority.',
  admin: 'Can manage channel setup and privileged watches.',
  member: 'Can start work and receive normal work updates.',
  approver: 'Can approve requests and unblock work on the go.',
  viewer: 'Can follow safe delivery updates.',
}

type Notice = {
  tone: 'success' | 'warning'
  message: string
}

export type ChannelsGatewaySurfaceProps = Omit<ComponentPropsWithoutRef<'section'>, 'onError'> & {
  providers: ChannelProviderStatus[]
  agents: ChannelAgentRecord[]
  bindings: ChannelBindingPublicRecord[]
  people: ChannelIdentityPublicRecord[]
  deliveries: ChannelDeliveryPublicRecord[]
  watches: CoordinationWatch[]
  loading?: boolean
  error?: string | null
  canManage?: boolean
  manageDisabledReason?: string
  platformLabel?: string
  allowProviderFallback?: boolean
  onReload?: () => Promise<unknown> | unknown
  onConnectProvider?: (provider: ChannelProviderKind) => Promise<unknown> | unknown
  onDisconnectBinding?: (bindingId: string) => Promise<unknown> | unknown
  onResolvePerson?: (input: ChannelPersonResolveInput) => Promise<unknown> | unknown
  onCreateWatch?: (input: CoordinationWatchInput) => Promise<unknown> | unknown
  onPauseWatch?: (watchId: string) => Promise<unknown> | unknown
  onResumeWatch?: (watchId: string) => Promise<unknown> | unknown
  onDeleteWatch?: (watchId: string) => Promise<unknown> | unknown
  onOpenDeliverySession?: (sessionId: string) => Promise<unknown> | unknown
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function maybeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Channel action failed.'
}

function providerKind(value: string | null | undefined) {
  return value ? channelProviderKindFromId(value) : null
}

function providerDisplayName(provider: string | null | undefined) {
  const kind = providerKind(provider || '')
  return kind ? channelProviderLabel(kind) : text(provider, 'Provider')
}

function roleLabel(role: ChannelIdentityRole | CoordinationWatchRecipientRole | null | undefined) {
  return role ? ROLE_LABELS[role] || role : 'Viewer'
}

function roleTone(role: ChannelIdentityRole | CoordinationWatchRecipientRole | null | undefined): BadgeTone {
  // Roles are metadata, not status — keep them as quiet tags. Only the Owner carries
  // the accent; everyone else is neutral/muted so the roster isn't a rainbow of chips.
  if (role === 'owner') return 'accent'
  if (role === 'viewer') return 'muted'
  return 'neutral'
}

function statusTone(status: string | null | undefined): BadgeTone {
  const value = String(status || '').toLowerCase()
  if (value === 'active' || value === 'connected' || value === 'sent') return 'success'
  // Only states that genuinely need the user are warning; benign transitional states stay neutral.
  if (value === 'auth_required') return 'warning'
  if (value === 'failed' || value === 'dead' || value === 'error' || value === 'disabled') return 'danger'
  return 'neutral'
}

function sensitive(value: string) {
  return /(secret:\/\/|token=|signed\?|leaked-secret|api[_-]?key|credential|password|bearer\s+)/i.test(value)
}

function safeDisplay(value: unknown, fallback = 'unassigned') {
  const next = text(value, fallback)
  if (!next) return fallback
  if (sensitive(next)) return '[redacted]'
  if (next.length > 72) return `${next.slice(0, 14)}...${next.slice(-8)}`
  return next
}

function metadataText(record: { metadata?: Record<string, unknown> }, key: string) {
  return text(record.metadata?.[key])
}

function personHandle(person: ChannelIdentityPublicRecord) {
  return safeDisplay(
    metadataText(person, 'displayName')
      || metadataText(person, 'handle')
      || metadataText(person, 'email')
      || person.externalUserId,
    'Unknown person',
  )
}

function personInitials(person: ChannelIdentityPublicRecord) {
  return personHandle(person)
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'CH'
}

function actionDisabledReason(canManage: boolean, reason: string) {
  return canManage ? undefined : reason
}

function watchTargetLabel(watch: CoordinationWatch) {
  return `${watch.target.kind} / ${safeDisplay(watch.target.id, 'target')}`
}

function watchRecipientLabel(watch: CoordinationWatch) {
  const recipient = watch.recipient
  if (!recipient) return 'Viewer'
  return safeDisplay(recipient.label || roleLabel(recipient.role) || recipient.identityId, 'Viewer')
}

function deliverySessionId(delivery: ChannelDeliveryPublicRecord) {
  const loose = delivery as ChannelDeliveryPublicRecord & { sessionId?: unknown }
  return text(loose.sessionId || delivery.payload?.sessionId)
}

function displayProviders(
  providers: ChannelProviderStatus[],
  bindings: ChannelBindingPublicRecord[],
  allowProviderFallback: boolean,
) {
  const fallbackCatalog = buildChannelProviderStatuses(bindings)
  const fallback = allowProviderFallback
    ? fallbackCatalog
    : fallbackCatalog.filter((provider) => provider.bindingCount > 0)
  const source = providers.length ? providers : fallback
  return DISPLAY_PROVIDER_ORDER.map((kind) => {
    const provider = source.find((candidate) => candidate.provider === kind)
      || fallback.find((candidate) => candidate.provider === kind)
    if (provider || !allowProviderFallback) return provider
    return {
      id: kind,
      provider: kind,
      label: channelProviderLabel(kind),
      available: true,
      connected: false,
      bindingCount: 0,
      activeBindingCount: 0,
      status: 'available' as const,
    }
  }).filter((provider): provider is ChannelProviderStatus => Boolean(provider))
}

function bindingAgentName(binding: ChannelBindingPublicRecord, agents: ChannelAgentRecord[]) {
  return agents.find((agent) => agent.agentId === binding.agentId)?.name || binding.agentId
}

function bindingLabel(bindings: ChannelBindingPublicRecord[], bindingId: string | null | undefined) {
  const binding = bindings.find((entry) => entry.bindingId === bindingId)
  return binding?.displayName || bindingId || 'Unbound channel'
}

function channelBindingOptionLabel(binding: ChannelBindingPublicRecord) {
  return `${binding.displayName || providerDisplayName(binding.provider)} (${providerDisplayName(binding.provider)})`
}

function bindingsForProvider(bindings: ChannelBindingPublicRecord[], provider: ChannelProviderKind) {
  return bindings.filter((binding) => providerKind(binding.provider) === provider)
}

function stringSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function defaultDeliveryChatId(binding: ChannelBindingPublicRecord | null) {
  if (!binding) return ''
  return (
    stringSetting(binding.settings, 'defaultChatId')
    || stringSetting(binding.settings, 'chatId')
    || stringSetting(binding.settings, 'externalChatId')
    || stringSetting(binding.settings, 'channelId')
    || stringSetting(binding.settings, 'roomId')
  )
}

function deliveryTargetForBinding(binding: ChannelBindingPublicRecord, chatId: string) {
  const target: Record<string, unknown> = {}
  if (binding.externalWorkspaceId) target.externalWorkspaceId = binding.externalWorkspaceId
  target.chatId = chatId
  target.externalChatId = chatId
  return target
}

function eventLabel(eventType: CoordinationWatchEventType) {
  return eventType.replace('.', ' ')
}

function ChannelsNotice({ notice, error }: { notice: Notice | null; error?: string | null }) {
  if (error) return <p className="studio-channel-notice" data-tone="warning">{safeDisplay(error, 'Channel surface failed to load.')}</p>
  if (!notice) return null
  return <p className="studio-channel-notice" data-tone={notice.tone}>{notice.message}</p>
}

function ConnectedChannels({
  bindings,
  agents,
  canManage,
  busy,
  disabledReason,
  onDisconnect,
}: {
  bindings: ChannelBindingPublicRecord[]
  agents: ChannelAgentRecord[]
  canManage: boolean
  busy: string | null
  disabledReason: string
  onDisconnect: (bindingId: string) => void
}) {
  const visible = bindings.filter((binding) => binding.status !== 'disabled')
  if (!visible.length) {
    return (
      <EmptyState
        icon="radio"
        title="No connected channels"
        body="Add WhatsApp, Telegram, Slack, Discord, Signal, Email, or Webhook channels to reach this workspace."
      />
    )
  }
  return (
    <div className="studio-channel-grid" id="channel-connected-grid">
      {visible.map((binding) => (
        <article className="studio-channel-card" key={binding.bindingId}>
          <div className="studio-channel-card__head">
            <span className="studio-channel-card__icon" aria-hidden="true">
              <Icon name="radio" size={16} />
            </span>
            <div>
              <h3>{safeDisplay(binding.displayName, 'Connected channel')}</h3>
              <p>{providerDisplayName(binding.provider)} - {safeDisplay(binding.externalWorkspaceId, 'tenant-wide')}</p>
            </div>
          </div>
          <div className="studio-channel-card__meta">
            <Badge tone={statusTone(binding.status)}>{binding.status}</Badge>
            <span>{safeDisplay(bindingAgentName(binding, agents), 'channel coworker')}</span>
          </div>
          <div className="studio-channel-actions">
            <Button
              size="sm"
              variant="ghost"
              data-admin-control="true"
              disabledReason={actionDisabledReason(canManage, disabledReason)}
              loading={busy === `disconnect:${binding.bindingId}`}
              onClick={() => onDisconnect(binding.bindingId)}
            >
              Disconnect
            </Button>
          </div>
        </article>
      ))}
    </div>
  )
}

function ProviderGrid({
  providers,
  bindings,
  canManage,
  busy,
  disabledReason,
  onConnect,
}: {
  providers: ChannelProviderStatus[]
  bindings: ChannelBindingPublicRecord[]
  canManage: boolean
  busy: string | null
  disabledReason: string
  onConnect: (provider: ChannelProviderKind) => void
}) {
  return (
    <div className="studio-channel-grid" id="channel-add-grid">
      {providers.map((provider) => {
        const providerBindings = bindingsForProvider(bindings, provider.provider)
        const setupBindings = providerBindings.filter((binding) => binding.status !== 'active' && binding.status !== 'disabled')
        const activeBindingCount = providerBindings.filter((binding) => binding.status === 'active').length || provider.activeBindingCount
        const connected = provider.connected || activeBindingCount > 0
        const setupInProgress = !connected && setupBindings.length > 0
        const unavailable = connected || setupInProgress
        const providerSummary = connected
          ? `${activeBindingCount} active binding(s)`
          : setupInProgress
            ? 'Setup in progress'
            : 'Available for gateway setup'
        return (
          <article className="studio-channel-card studio-channel-card--provider" key={provider.provider}>
            <div className="studio-channel-card__head">
              <span className="studio-channel-card__icon" aria-hidden="true">
                <Icon name={connected ? 'badge-check' : setupInProgress ? 'loader-circle' : 'plus'} size={16} />
              </span>
              <div>
                <h3>{provider.label}</h3>
                <p>{providerSummary}</p>
              </div>
            </div>
            <div className="studio-channel-card__meta">
              <Badge tone={connected ? 'success' : setupInProgress ? 'warning' : 'neutral'}>{connected ? 'Connected' : setupInProgress ? 'Pending' : 'Available'}</Badge>
            </div>
            <div className="studio-channel-actions">
              <Button
                size="sm"
                variant={unavailable ? 'secondary' : 'primary'}
                data-admin-control="true"
                disabled={unavailable}
                disabledReason={connected
                  ? 'This provider already has an active channel.'
                  : setupInProgress
                    ? 'This provider already has channel setup in progress.'
                    : actionDisabledReason(canManage, disabledReason)}
                loading={busy === `connect:${provider.provider}`}
                onClick={() => onConnect(provider.provider)}
              >
                {connected ? 'Connected' : setupInProgress ? 'Pending' : 'Connect'}
              </Button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function PeopleRoster({
  people,
  bindings,
  canManage,
  busy,
  disabledReason,
  onInvite,
}: {
  people: ChannelIdentityPublicRecord[]
  bindings: ChannelBindingPublicRecord[]
  canManage: boolean
  busy: string | null
  disabledReason: string
  onInvite: (input: ChannelPersonResolveInput) => void
}) {
  const activeBindings = bindings.filter((binding) => binding.status === 'active')
  const [handle, setHandle] = useState('')
  const [role, setRole] = useState<ChannelIdentityRole>('member')
  const [bindingId, setBindingId] = useState(activeBindings[0]?.bindingId || '')
  const selectedBindingId = bindingId || activeBindings[0]?.bindingId || ''
  const selectedBinding = activeBindings.find((binding) => binding.bindingId === selectedBindingId) || activeBindings[0] || null
  const inviteDisabledReason = !activeBindings.length
    ? 'Connect a channel before inviting people.'
    : disabledReason

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextHandle = handle.trim()
    if (!selectedBinding || !nextHandle) return
    onInvite({
      provider: selectedBinding.provider,
      channelBindingId: selectedBinding.bindingId,
      externalWorkspaceId: selectedBinding.externalWorkspaceId,
      externalUserId: nextHandle,
      role,
      status: 'active',
      metadata: {
        handle: nextHandle,
        displayName: nextHandle,
      },
    })
    setHandle('')
  }

  return (
    <div className="studio-channel-panel">
      <div className="studio-channel-panel__head">
        <div>
          <h2>People</h2>
          <p>Channel identities, provider handles, and delivery roles.</p>
        </div>
        <Badge tone="neutral">{people.length} people</Badge>
      </div>
      <div className="studio-channel-list" id="channel-people-list">
        {people.length ? people.map((person) => (
          <div className="studio-person-row row compact" key={person.identityId}>
            <CoworkerAvatar name={personHandle(person)} initials={personInitials(person)} size="sm" tone={person.role === 'owner' ? 'lead' : person.role === 'approver' ? 'reviewer' : 'operator'} />
            <div className="studio-person-row__copy">
              <h3>{personHandle(person)}</h3>
              <div>
                <span className="studio-channel-chip">{providerDisplayName(person.provider)}</span>
                <span>{safeDisplay(person.externalWorkspaceId, 'tenant-wide')}</span>
              </div>
            </div>
            <div className="studio-person-row__role">
              <Badge tone={roleTone(person.role)}>{roleLabel(person.role)}</Badge>
              <span>{ROLE_DESCRIPTIONS[person.role]}</span>
            </div>
          </div>
        )) : (
          <p className="empty">No people loaded.</p>
        )}
      </div>
      <form className="studio-channel-form" onSubmit={submit}>
        <h3>Invite</h3>
        <div className="studio-channel-form__grid">
          <label className="span">
            <span>Handle</span>
            <input data-admin-control="true" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@teammate or email" disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? inviteDisabledReason : undefined} />
          </label>
          <label>
            <span>Via channel</span>
            <select data-admin-control="true" value={selectedBindingId} onChange={(event) => setBindingId(event.target.value)} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? inviteDisabledReason : undefined}>
              {activeBindings.map((binding) => <option value={binding.bindingId} key={binding.bindingId}>{channelBindingOptionLabel(binding)}</option>)}
            </select>
          </label>
          <label>
            <span>Role</span>
            <select data-admin-control="true" value={role} onChange={(event) => setRole(event.target.value as ChannelIdentityRole)} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? inviteDisabledReason : undefined}>
              {CHANNEL_ROLE_ORDER.map((nextRole) => <option value={nextRole} key={nextRole}>{roleLabel(nextRole)}</option>)}
            </select>
          </label>
          <Button
            className="span"
            type="submit"
            variant="secondary"
            size="sm"
            data-admin-control="true"
            disabled={!handle.trim() || !activeBindings.length}
            disabledReason={actionDisabledReason(canManage, inviteDisabledReason)}
            loading={busy === 'invite'}
          >
            Invite
          </Button>
        </div>
      </form>
    </div>
  )
}

function WatchesPanel({
  watches,
  bindings,
  canManage,
  busy,
  disabledReason,
  onCreate,
  onPause,
  onResume,
  onDelete,
}: {
  watches: CoordinationWatch[]
  bindings: ChannelBindingPublicRecord[]
  canManage: boolean
  busy: string | null
  disabledReason: string
  onCreate: (input: CoordinationWatchInput) => void
  onPause: (watchId: string) => void
  onResume: (watchId: string) => void
  onDelete: (watchId: string) => void
}) {
  const activeBindings = bindings.filter((binding) => binding.status === 'active')
  const [targetKind, setTargetKind] = useState<CoordinationWatchTarget>('project')
  const [targetId, setTargetId] = useState('')
  const [bindingId, setBindingId] = useState(activeBindings[0]?.bindingId || '')
  const [deliveryChatId, setDeliveryChatId] = useState('')
  const [recipientRole, setRecipientRole] = useState<CoordinationWatchRecipientRole>('approver')
  const [events, setEvents] = useState<CoordinationWatchEventType[]>(['task.moved', 'needs_input'])
  const selectedBindingId = bindingId || activeBindings[0]?.bindingId || ''
  const selectedBinding = activeBindings.find((binding) => binding.bindingId === selectedBindingId) || activeBindings[0] || null
  const selectedBindingDefaultChatId = defaultDeliveryChatId(selectedBinding)
  const selectedDeliveryChatId = deliveryChatId.trim() || selectedBindingDefaultChatId
  const createDisabledReason = !activeBindings.length
    ? 'Connect a channel before adding watches.'
    : !selectedDeliveryChatId
      ? 'Enter a provider chat or channel target for watch deliveries.'
    : disabledReason

  const toggleEvent = (eventType: CoordinationWatchEventType) => {
    setEvents((current) => (
      current.includes(eventType)
        ? current.filter((entry) => entry !== eventType)
        : [...current, eventType]
    ))
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextTargetId = targetId.trim()
    const nextDeliveryChatId = selectedDeliveryChatId.trim()
    if (!selectedBinding || !nextTargetId || !nextDeliveryChatId || !events.length) return
    onCreate({
      target: { kind: targetKind, id: nextTargetId },
      events,
      channel: {
        provider: selectedBinding.provider,
        agentId: selectedBinding.agentId,
        channelBindingId: selectedBinding.bindingId,
        target: deliveryTargetForBinding(selectedBinding, nextDeliveryChatId),
      },
      recipient: {
        role: recipientRole,
        label: roleLabel(recipientRole),
      },
      deliverySurface: 'gateway_channel',
      verbosity: 'normal',
      status: 'active',
    })
    setTargetId('')
    setDeliveryChatId('')
  }

  return (
    <div className="studio-channel-panel">
      <div className="studio-channel-panel__head">
        <div>
          <h2>Watches</h2>
          <p>Project and conversation events delivered to channels.</p>
        </div>
        <Badge tone="neutral">{watches.length} watches</Badge>
      </div>
      <div className="studio-channel-list" id="channel-watch-list">
        {watches.length ? watches.map((watch) => (
          <div className="studio-channel-watch row compact" key={watch.id}>
            <div className="studio-channel-watch__copy">
              <h3>{watchTargetLabel(watch)}</h3>
              <p>{watch.events.map(eventLabel).join(', ') || 'No events'} - {bindingLabel(bindings, watch.channel.channelBindingId)}</p>
              <small>{watchRecipientLabel(watch)} - {roleLabel(watch.recipient?.role)}</small>
            </div>
            <div className="studio-channel-actions">
              <Badge tone={statusTone(watch.status)}>{watch.status}</Badge>
              {watch.status === 'paused' ? (
                <Button size="sm" variant="ghost" data-admin-control="true" loading={busy === `resume:${watch.id}`} disabledReason={actionDisabledReason(canManage, disabledReason)} onClick={() => onResume(watch.id)}>Resume</Button>
              ) : (
                <Button size="sm" variant="ghost" data-admin-control="true" loading={busy === `pause:${watch.id}`} disabledReason={actionDisabledReason(canManage, disabledReason)} onClick={() => onPause(watch.id)}>Pause</Button>
              )}
              <Button size="sm" variant="danger" data-admin-control="true" loading={busy === `delete:${watch.id}`} disabledReason={actionDisabledReason(canManage, disabledReason)} onClick={() => onDelete(watch.id)}>Delete</Button>
            </div>
          </div>
        )) : (
          <p className="empty">No watches loaded.</p>
        )}
      </div>
      <form className="studio-channel-form" onSubmit={submit}>
        <h3>Add watch</h3>
        <div className="studio-channel-form__grid">
          <label>
            <span>Target</span>
            <select data-admin-control="true" value={targetKind} onChange={(event) => setTargetKind(event.target.value as CoordinationWatchTarget)} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined}>
              {WATCH_TARGET_ORDER.map((kind) => <option value={kind} key={kind}>{kind}</option>)}
            </select>
          </label>
          <label>
            <span>Target id</span>
            <input data-admin-control="true" value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="project-123" disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined} />
          </label>
          <label>
            <span>Channel</span>
            <select data-admin-control="true" value={selectedBindingId} onChange={(event) => { setBindingId(event.target.value); setDeliveryChatId('') }} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined}>
              {activeBindings.map((binding) => <option value={binding.bindingId} key={binding.bindingId}>{channelBindingOptionLabel(binding)}</option>)}
            </select>
          </label>
          <label>
            <span>Delivery chat</span>
            <input data-admin-control="true" value={deliveryChatId} onChange={(event) => setDeliveryChatId(event.target.value)} placeholder={selectedBindingDefaultChatId ? `Default: ${safeDisplay(selectedBindingDefaultChatId, 'chat')}` : 'chat-1 / channel id'} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined} />
          </label>
          <label>
            <span>Recipient</span>
            <select data-admin-control="true" value={recipientRole} onChange={(event) => setRecipientRole(event.target.value as CoordinationWatchRecipientRole)} disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined}>
              {CHANNEL_ROLE_ORDER.map((role) => <option value={role} key={role}>{roleLabel(role)}</option>)}
            </select>
          </label>
          <fieldset className="studio-channel-checkboxes span" disabled={!canManage || !activeBindings.length} title={!canManage || !activeBindings.length ? createDisabledReason : undefined}>
            <legend>Events</legend>
            {WATCH_EVENT_ORDER.map((eventType) => (
              <label key={eventType}>
                <input data-admin-control="true" type="checkbox" checked={events.includes(eventType)} onChange={() => toggleEvent(eventType)} />
                <span>{eventLabel(eventType)}</span>
              </label>
            ))}
          </fieldset>
          <Button
            className="span"
            type="submit"
            variant="secondary"
            size="sm"
            data-admin-control="true"
            disabled={!targetId.trim() || !selectedDeliveryChatId || !activeBindings.length || events.length === 0}
            disabledReason={!canManage || !activeBindings.length || !selectedDeliveryChatId ? createDisabledReason : undefined}
            loading={busy === 'watch:create'}
          >
            Add watch
          </Button>
        </div>
      </form>
    </div>
  )
}

function DeliveryRows({
  deliveries,
  bindings,
  onOpenDeliverySession,
}: Pick<ChannelsGatewaySurfaceProps, 'deliveries' | 'bindings' | 'onOpenDeliverySession'>) {
  if (!deliveries.length) return <p className="empty">No channel deliveries loaded.</p>
  return (
    <div className="studio-channel-list studio-channel-deliveries" id="channel-delivery-list">
      {deliveries.slice(0, 50).map((delivery) => {
        const sessionId = deliverySessionId(delivery)
        return (
          <div className="studio-channel-delivery-row row compact" key={delivery.deliveryId}>
            <div>
              <h3>{safeDisplay(delivery.eventType || delivery.deliveryId, 'Channel delivery')}</h3>
              <p>{providerDisplayName(delivery.provider)} - {bindingLabel(bindings, delivery.channelBindingId)} - attempt {delivery.attemptCount}</p>
            </div>
            <div className="studio-channel-actions">
              <Badge tone={statusTone(delivery.status)}>{delivery.status}</Badge>
              {sessionId && onOpenDeliverySession ? (
                <Button size="sm" variant="ghost" onClick={() => void onOpenDeliverySession(sessionId)}>Open chat</Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ChannelsGatewaySurface({
  providers,
  agents,
  bindings,
  people,
  deliveries,
  watches,
  loading = false,
  error = null,
  canManage = true,
  manageDisabledReason = 'Admin permissions are required for channel setup.',
  platformLabel = 'Studio channels',
  allowProviderFallback = true,
  onReload,
  onConnectProvider,
  onDisconnectBinding,
  onResolvePerson,
  onCreateWatch,
  onPauseWatch,
  onResumeWatch,
  onDeleteWatch,
  onOpenDeliverySession,
  className,
  ...props
}: ChannelsGatewaySurfaceProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const providerStatuses = useMemo(() => displayProviders(providers, bindings, allowProviderFallback), [allowProviderFallback, bindings, providers])

  const runAction = async (busyKey: string, successMessage: string, action: () => Promise<unknown> | unknown) => {
    setBusy(busyKey)
    setNotice(null)
    try {
      await action()
      setNotice({ tone: 'success', message: successMessage })
      await onReload?.()
    } catch (actionError) {
      setNotice({ tone: 'warning', message: maybeErrorMessage(actionError) })
    } finally {
      setBusy(null)
    }
  }

  const connectProvider = (provider: ChannelProviderKind) => {
    if (!onConnectProvider) return
    void runAction(`connect:${provider}`, `${channelProviderLabel(provider)} channel setup started.`, () => onConnectProvider(provider))
  }

  const disconnectBinding = (bindingId: string) => {
    if (!onDisconnectBinding) return
    void runAction(`disconnect:${bindingId}`, 'Channel disconnected.', () => onDisconnectBinding(bindingId))
  }

  const invitePerson = (input: ChannelPersonResolveInput) => {
    if (!onResolvePerson) return
    void runAction('invite', 'Person added to the channel roster.', () => onResolvePerson(input))
  }

  const createWatch = (input: CoordinationWatchInput) => {
    if (!onCreateWatch) return
    void runAction('watch:create', 'Watch created.', () => onCreateWatch(input))
  }

  const pauseWatch = (watchId: string) => {
    if (!onPauseWatch) return
    void runAction(`pause:${watchId}`, 'Watch paused.', () => onPauseWatch(watchId))
  }

  const resumeWatch = (watchId: string) => {
    if (!onResumeWatch) return
    void runAction(`resume:${watchId}`, 'Watch resumed.', () => onResumeWatch(watchId))
  }

  const deleteWatch = (watchId: string) => {
    if (!onDeleteWatch) return
    void runAction(`delete:${watchId}`, 'Watch deleted.', () => onDeleteWatch(watchId))
  }

  return (
    <section {...props} className={cn('studio-channels-surface', className)}>
      <StudioPageHeader
        eyebrow="Gateway"
        title="Channels"
        description="Connect channels, map people, and subscribe watches while OpenCode remains the execution runtime."
        meta={(
          <div className="studio-channel-header-meta">
            <Badge tone={canManage ? 'accent' : 'neutral'}>{canManage ? 'Setup enabled' : 'Admin gated'}</Badge>
            <span>{platformLabel}</span>
          </div>
        )}
        actions={[
          {
            id: 'reload',
            children: loading ? 'Refreshing' : 'Refresh',
            variant: 'secondary',
            leftIcon: 'rotate-ccw',
            disabled: loading,
            onClick: () => { void onReload?.() },
          },
        ]}
      />
      <ChannelsNotice notice={notice} error={error} />
      <div className="studio-channel-dashboard">
        <div className="studio-channel-panel">
          <div className="studio-channel-panel__head">
            <div>
              <h2>Connected</h2>
              <p>Active gateway bindings and the coworker they route to.</p>
            </div>
          </div>
          <ConnectedChannels
            bindings={bindings}
            agents={agents}
            canManage={canManage}
            busy={busy}
            disabledReason={manageDisabledReason}
            onDisconnect={disconnectBinding}
          />
        </div>
        <div className="studio-channel-panel">
          <div className="studio-channel-panel__head">
            <div>
              <h2>Add a channel</h2>
              <p>WhatsApp, Telegram, Slack, Discord, Signal, Email, and Webhook.</p>
            </div>
          </div>
          <ProviderGrid
            providers={providerStatuses}
            bindings={bindings}
            canManage={canManage}
            busy={busy}
            disabledReason={manageDisabledReason}
            onConnect={connectProvider}
          />
        </div>
        <PeopleRoster
          people={people}
          bindings={bindings}
          canManage={canManage}
          busy={busy}
          disabledReason={manageDisabledReason}
          onInvite={invitePerson}
        />
        <WatchesPanel
          watches={watches}
          bindings={bindings}
          canManage={canManage}
          busy={busy}
          disabledReason={manageDisabledReason}
          onCreate={createWatch}
          onPause={pauseWatch}
          onResume={resumeWatch}
          onDelete={deleteWatch}
        />
        <div className="studio-channel-panel">
          <div className="studio-channel-panel__head">
            <div>
              <h2>Delivery status</h2>
              <p>Recent channel delivery attempts without provider secrets or payload internals.</p>
            </div>
            <Badge tone="neutral">{Math.min(deliveries.length, 50)} shown</Badge>
          </div>
          <DeliveryRows deliveries={deliveries} bindings={bindings} onOpenDeliverySession={onOpenDeliverySession} />
        </div>
      </div>
    </section>
  )
}
