import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChannelActivationMode,
  ChannelDefinition,
  LocalWebhookChannelPairing,
  LocalWebhookChannelPairingResult,
  LocalWebhookReceiverStatus,
  SopListItem,
  CrewListItem,
  WorkspaceProfile,
} from '@open-cowork/shared'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

const CHANNEL_SANDBOX_PROFILE_ID = 'channel-sandbox'
const textareaCls = `${inputCls} min-h-[74px] resize-y leading-relaxed`

type ChannelFormState = {
  name: string
  description: string
  sourceKey: string
  senderAllowlist: string
  activationMode: ChannelActivationMode
  targetSopId: string
  targetCrewId: string
  allowedCapabilityIds: string
  workspaceProfileId: string
}

type RevealedToken = {
  channelId: string
  sourceKey: string
  token: string
  endpoint: string | null
}

type ChannelPanelData = {
  status: LocalWebhookReceiverStatus
  channels: ChannelDefinition[]
  pairings: LocalWebhookChannelPairing[]
  sops: SopListItem[]
  crews: CrewListItem[]
}

async function fetchChannelPanelData(): Promise<ChannelPanelData> {
  const [
    status,
    channels,
    pairings,
    sops,
    crews,
  ] = await Promise.all([
    window.coworkApi.channels.localWebhookStatus(),
    window.coworkApi.channels.definitions(),
    window.coworkApi.channels.localWebhookPairings(),
    window.coworkApi.sops.list(),
    window.coworkApi.crews.list(),
  ])
  return {
    status,
    channels,
    pairings,
    sops: sops.sops,
    crews: crews.crews,
  }
}

function parseList(value: string) {
  return [...new Set(value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean))]
}

function sourceKeyFromName(value: string) {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function receiverEndpoint(status: LocalWebhookReceiverStatus | null, sourceKey: string) {
  if (!status?.url) return null
  return status.url.replace(':sourceKey', encodeURIComponent(sourceKey))
}

function defaultWorkspaceProfileId(workspaceProfiles: WorkspaceProfile[]) {
  const channelProfile = workspaceProfiles.find((profile) => profile.id === CHANNEL_SANDBOX_PROFILE_ID)
    || workspaceProfiles.find((profile) => profile.kind === 'channel_sandbox')
    || workspaceProfiles.find((profile) => profile.authority.isolation.channelBound)
  return channelProfile?.id || CHANNEL_SANDBOX_PROFILE_ID
}

function emptyForm(workspaceProfiles: WorkspaceProfile[]): ChannelFormState {
  return {
    name: '',
    description: '',
    sourceKey: '',
    senderAllowlist: '',
    activationMode: 'ask_user',
    targetSopId: '',
    targetCrewId: '',
    allowedCapabilityIds: '',
    workspaceProfileId: defaultWorkspaceProfileId(workspaceProfiles),
  }
}

function describeChannelError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportChannelsError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describeChannelError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'settings-channels',
    })
  } catch {
    // Diagnostics are best-effort from a settings recovery path.
  }
}

function StatusPill({ tone, children }: { tone: 'green' | 'amber' | 'muted'; children: string }) {
  const color = tone === 'green'
    ? 'var(--color-green)'
    : tone === 'amber'
      ? 'var(--color-orange)'
      : 'var(--color-text-muted)'
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}

function ChannelStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 break-words text-[13px] font-medium text-text">{value}</div>
    </div>
  )
}

function describeActivationMode(mode: ChannelActivationMode) {
  switch (mode) {
    case 'ignore':
      return t('settings.channels.mode.ignore', 'Ignore')
    case 'draft_reply':
      return t('settings.channels.mode.draftReply', 'Draft reply')
    case 'ask_user':
      return t('settings.channels.mode.askUser', 'Ask user')
    case 'run_sop':
      return t('settings.channels.mode.runSop', 'Run SOP')
    case 'run_crew':
      return t('settings.channels.mode.runCrew', 'Run Crew')
  }
}

function PairingCard({
  pairing,
  channel,
  status,
  rotating,
  onRotate,
}: {
  pairing: LocalWebhookChannelPairing
  channel: ChannelDefinition | undefined
  status: LocalWebhookReceiverStatus | null
  rotating: boolean
  onRotate: (channelId: string) => void
}) {
  const endpoint = receiverEndpoint(status, pairing.sourceKey)
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-text">{channel?.name || pairing.sourceKey}</div>
          <div className="mt-1 text-[11px] text-text-muted">
            {pairing.sourceKey} · {t('settings.channels.tokenPrefix', 'token')} {pairing.tokenPrefix}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRotate(pairing.channelId)}
          disabled={rotating}
          className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] font-semibold text-text-secondary transition-colors hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {rotating ? t('settings.channels.rotating', 'Rotating...') : t('settings.channels.rotateToken', 'Rotate token')}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 max-[980px]:grid-cols-1">
        <ChannelStat label={t('settings.channels.route', 'Route')} value={channel ? describeActivationMode(channel.route.activationMode) : t('common.unknown', 'Unknown')} />
        <ChannelStat label={t('settings.channels.workspace', 'Workspace')} value={channel?.workspaceProfileId || CHANNEL_SANDBOX_PROFILE_ID} />
      </div>
      {endpoint ? (
        <div className="mt-3 break-all rounded-xl border border-border-subtle bg-base px-3 py-2 font-mono text-[10px] text-text-muted">
          {endpoint}
        </div>
      ) : null}
    </div>
  )
}

export function ChannelsPanel({ workspaceProfiles }: { workspaceProfiles: WorkspaceProfile[] }) {
  const [status, setStatus] = useState<LocalWebhookReceiverStatus | null>(null)
  const [channels, setChannels] = useState<ChannelDefinition[]>([])
  const [pairings, setPairings] = useState<LocalWebhookChannelPairing[]>([])
  const [sops, setSops] = useState<SopListItem[]>([])
  const [crews, setCrews] = useState<CrewListItem[]>([])
  const [form, setForm] = useState<ChannelFormState>(() => emptyForm(workspaceProfiles))
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [rotatingChannelId, setRotatingChannelId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<RevealedToken | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const refreshVersionRef = useRef(0)

  const channelWorkspaceProfiles = useMemo(
    () => workspaceProfiles.filter((profile) => profile.authority.isolation.channelBound),
    [workspaceProfiles],
  )
  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels])
  const localWebhookChannels = useMemo(
    () => channels.filter((channel) => channel.provider === 'local_webhook'),
    [channels],
  )

  useEffect(() => {
    setForm((current) => {
      if (current.workspaceProfileId && (
        current.workspaceProfileId === CHANNEL_SANDBOX_PROFILE_ID
        || channelWorkspaceProfiles.some((profile) => profile.id === current.workspaceProfileId)
      )) {
        return current
      }
      return { ...current, workspaceProfileId: defaultWorkspaceProfileId(workspaceProfiles) }
    })
  }, [channelWorkspaceProfiles, workspaceProfiles])

  const load = useCallback(async () => {
    const refreshVersion = refreshVersionRef.current + 1
    refreshVersionRef.current = refreshVersion
    setLoading(true)
    setError(null)
    try {
      const data = await fetchChannelPanelData()
      if (refreshVersionRef.current !== refreshVersion) return
      setStatus(data.status)
      setChannels(data.channels)
      setPairings(data.pairings)
      setSops(data.sops)
      setCrews(data.crews)
    } catch (err) {
      if (refreshVersionRef.current !== refreshVersion) return
      addGlobalError(t('settings.channels.loadFailed', 'Could not load channel settings. Please try again.'))
      reportChannelsError(err, 'Failed to load channel settings')
      setError(describeChannelError(err))
    } finally {
      if (refreshVersionRef.current === refreshVersion) setLoading(false)
    }
  }, [addGlobalError])

  useEffect(() => {
    void load()
    return () => {
      refreshVersionRef.current += 1
    }
  }, [load])

  const updateForm = (patch: Partial<ChannelFormState>) => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const updateName = (value: string) => {
    setForm((current) => ({
      ...current,
      name: value,
      sourceKey: current.sourceKey && current.sourceKey !== sourceKeyFromName(current.name)
        ? current.sourceKey
        : sourceKeyFromName(value),
    }))
  }

  const createWebhook = async () => {
    setWorking(true)
    setError(null)
    setCopyStatus('idle')
    try {
      const result = await window.coworkApi.channels.createLocalWebhook({
        name: form.name.trim(),
        description: form.description.trim() || null,
        sourceKey: form.sourceKey.trim(),
        enabled: true,
        senderAllowlist: parseList(form.senderAllowlist),
        allowedCapabilityIds: parseList(form.allowedCapabilityIds),
        route: {
          activationMode: form.activationMode,
          targetSopId: form.activationMode === 'run_sop' ? form.targetSopId || null : null,
          targetCrewId: form.activationMode === 'run_crew' ? form.targetCrewId || null : null,
        },
        workspaceProfileId: form.workspaceProfileId || CHANNEL_SANDBOX_PROFILE_ID,
      })
      setToken({
        channelId: result.channel.id,
        sourceKey: result.channel.sourceKey,
        token: result.token,
        endpoint: receiverEndpoint(status, result.channel.sourceKey),
      })
      setForm(emptyForm(workspaceProfiles))
      await load()
    } catch (err) {
      setError(describeChannelError(err))
      reportChannelsError(err, 'Failed to create local webhook channel')
    } finally {
      setWorking(false)
    }
  }

  const rotateToken = async (channelId: string) => {
    setRotatingChannelId(channelId)
    setError(null)
    setCopyStatus('idle')
    try {
      const result: LocalWebhookChannelPairingResult | null = await window.coworkApi.channels.rotateLocalWebhookToken(channelId)
      if (!result) {
        setError(t('settings.channels.rotateMissing', 'Channel token could not be rotated.'))
        return
      }
      setToken({
        channelId: result.channel.id,
        sourceKey: result.channel.sourceKey,
        token: result.token,
        endpoint: receiverEndpoint(status, result.channel.sourceKey),
      })
      await load()
    } catch (err) {
      setError(describeChannelError(err))
      reportChannelsError(err, 'Failed to rotate local webhook token')
    } finally {
      setRotatingChannelId(null)
    }
  }

  const copyToken = async () => {
    if (!token) return
    const copied = await writeTextToClipboard(token.token)
    setCopyStatus(copied ? 'copied' : 'failed')
  }

  const receiverTone = status?.listening ? 'green' : status?.enabled ? 'amber' : 'muted'
  const receiverText = status?.listening
    ? t('settings.channels.receiverListening', 'Listening')
    : status?.enabled
      ? t('settings.channels.receiverStarting', 'Enabled')
      : t('settings.channels.receiverDisabled', 'Disabled')
  const endpointPreview = form.sourceKey.trim() ? receiverEndpoint(status, form.sourceKey) : status?.url || null
  const canCreate = Boolean(form.name.trim()
    && form.sourceKey.trim()
    && parseList(form.senderAllowlist).length > 0
    && (form.activationMode !== 'run_sop' || form.targetSopId)
    && (form.activationMode !== 'run_crew' || form.targetCrewId))

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.channels.receiverHeader', 'Local Webhook Receiver')}</span>
      <div className={panelCardCls}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-text">{t('settings.channels.receiverTitle', 'Receiver status')}</div>
            <div className="mt-1 text-[11px] text-text-muted leading-relaxed">
              {status?.lastError || t('settings.channels.receiverDescription', 'Inbound items are accepted only from paired source keys and allowlisted senders.')}
            </div>
          </div>
          <StatusPill tone={receiverTone}>{receiverText}</StatusPill>
        </div>
        <div className="grid grid-cols-3 gap-3 max-[980px]:grid-cols-1">
          <ChannelStat label={t('settings.channels.host', 'Host')} value={status ? `${status.host}:${status.port || '-'}` : '-'} />
          <ChannelStat label={t('settings.channels.paired', 'Paired channels')} value={String(status?.pairedChannels ?? pairings.length)} />
          <ChannelStat label={t('settings.channels.localChannels', 'Local channels')} value={String(localWebhookChannels.length)} />
        </div>
      </div>

      <span className={sectionLabelCls}>{t('settings.channels.createHeader', 'New Pairing')}</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.name', 'Name')}</span>
            <input
              value={form.name}
              onChange={(event) => updateName(event.target.value)}
              className={inputCls}
              placeholder={t('settings.channels.namePlaceholder', 'Support inbox')}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.sourceKey', 'Source key')}</span>
            <input
              value={form.sourceKey}
              onChange={(event) => updateForm({ sourceKey: event.target.value })}
              className={inputCls}
              placeholder={t('settings.channels.sourceKeyPlaceholder', 'support-inbox')}
            />
          </label>
        </div>

        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.channels.description', 'Description')}</span>
          <input
            value={form.description}
            onChange={(event) => updateForm({ description: event.target.value })}
            className={inputCls}
            placeholder={t('settings.channels.descriptionPlaceholder', 'Inbound customer messages')}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.channels.senderAllowlist', 'Sender allowlist')}</span>
          <textarea
            value={form.senderAllowlist}
            onChange={(event) => updateForm({ senderAllowlist: event.target.value })}
            className={textareaCls}
            placeholder={t('settings.channels.senderAllowlistPlaceholder', 'ops@example.com\n*@trusted.example')}
          />
        </label>

        <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.activationMode', 'Activation mode')}</span>
            <select
              value={form.activationMode}
              onChange={(event) => updateForm({ activationMode: event.target.value as ChannelActivationMode })}
              className={inputCls}
            >
              <option value="ignore">{describeActivationMode('ignore')}</option>
              <option value="draft_reply">{describeActivationMode('draft_reply')}</option>
              <option value="ask_user">{describeActivationMode('ask_user')}</option>
              <option value="run_sop">{describeActivationMode('run_sop')}</option>
              <option value="run_crew">{describeActivationMode('run_crew')}</option>
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.workspaceProfile', 'Workspace profile')}</span>
            <select
              value={form.workspaceProfileId}
              onChange={(event) => updateForm({ workspaceProfileId: event.target.value })}
              className={inputCls}
            >
              {channelWorkspaceProfiles.length === 0 ? (
                <option value={CHANNEL_SANDBOX_PROFILE_ID}>{CHANNEL_SANDBOX_PROFILE_ID}</option>
              ) : channelWorkspaceProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
        </div>

        {form.activationMode === 'run_sop' ? (
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.targetSop', 'Target SOP')}</span>
            <select
              value={form.targetSopId}
              onChange={(event) => updateForm({ targetSopId: event.target.value })}
              className={inputCls}
            >
              <option value="">{t('settings.channels.chooseSop', 'Choose SOP')}</option>
              {sops.map((entry) => (
                <option key={entry.definition.id} value={entry.definition.id}>
                  {entry.definition.name} · {entry.definition.status}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {form.activationMode === 'run_crew' ? (
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.channels.targetCrew', 'Target Crew')}</span>
            <select
              value={form.targetCrewId}
              onChange={(event) => updateForm({ targetCrewId: event.target.value })}
              className={inputCls}
            >
              <option value="">{t('settings.channels.chooseCrew', 'Choose Crew')}</option>
              {crews.map((entry) => (
                <option key={entry.definition.id} value={entry.definition.id}>
                  {entry.definition.name} · {entry.definition.status}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.channels.allowedCapabilities', 'Allowed capability IDs')}</span>
          <textarea
            value={form.allowedCapabilityIds}
            onChange={(event) => updateForm({ allowedCapabilityIds: event.target.value })}
            className={textareaCls}
            placeholder={t('settings.channels.allowedCapabilitiesPlaceholder', 'capability-id-one\ncapability-id-two')}
          />
        </label>

        {endpointPreview ? (
          <div className="break-all rounded-xl border border-border-subtle bg-base px-3 py-2 font-mono text-[10px] text-text-muted">
            {endpointPreview}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-text-muted">
            {loading ? t('settings.channels.loading', 'Loading channel state...') : t('settings.channels.createHint', 'New local webhook channels start enabled and require bearer token pairing.')}
          </div>
          <button
            type="button"
            onClick={createWebhook}
            disabled={!canCreate || working}
            className="rounded-xl px-4 py-2 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-foreground)',
            }}
          >
            {working ? t('settings.channels.creating', 'Creating...') : t('settings.channels.createPairing', 'Create pairing')}
          </button>
        </div>
      </div>

      {token ? (
        <div className={panelCardCls}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold text-text">{t('settings.channels.tokenReady', 'Pairing token ready')}</div>
              <div className="mt-1 text-[11px] text-text-muted">
                {token.sourceKey}
              </div>
            </div>
            <button
              type="button"
              onClick={copyToken}
              className="rounded-xl border border-border-subtle px-3 py-2 text-[11px] font-semibold text-text-secondary transition-colors hover:border-accent/40 hover:text-text"
            >
              {copyStatus === 'copied'
                ? t('settings.channels.copied', 'Copied')
                : copyStatus === 'failed'
                  ? t('settings.channels.copyFailed', 'Copy failed')
                  : t('settings.channels.copyToken', 'Copy token')}
            </button>
          </div>
          <div className="break-all rounded-xl border border-border-subtle bg-base px-3 py-2 font-mono text-[10px] text-text">
            {token.token}
          </div>
          {token.endpoint ? (
            <div className="break-all rounded-xl border border-border-subtle bg-base px-3 py-2 font-mono text-[10px] text-text-muted">
              {token.endpoint}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border px-4 py-3 text-[12px]" style={{
          color: 'var(--color-red)',
          borderColor: 'color-mix(in srgb, var(--color-red) 32%, transparent)',
          background: 'color-mix(in srgb, var(--color-red) 8%, transparent)',
        }}>
          {error}
        </div>
      ) : null}

      <span className={sectionLabelCls}>{t('settings.channels.pairingsHeader', 'Existing Pairings')}</span>
      {pairings.length === 0 ? (
        <div className={panelCardCls}>
          <div className="text-[12px] text-text-muted">{t('settings.channels.emptyPairings', 'No local webhook pairings yet.')}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {pairings.map((pairing) => (
            <PairingCard
              key={pairing.channelId}
              pairing={pairing}
              channel={channelsById.get(pairing.channelId)}
              status={status}
              rotating={rotatingChannelId === pairing.channelId}
              onRotate={rotateToken}
            />
          ))}
        </div>
      )}
    </div>
  )
}
