import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChannelsGatewaySurface,
  type ChannelsGatewaySurfaceProps,
} from '@open-cowork/ui'
import {
  channelProviderLabel,
  type ChannelAgentRecord,
  type ChannelBindingPublicRecord,
  type ChannelDeliveryPublicRecord,
  type ChannelIdentityPublicRecord,
  type ChannelProviderKind,
  type ChannelProviderStatus,
  type CoordinationWatch,
  type CoordinationWatchInput,
} from '@open-cowork/shared'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { asRecord, errorMessage, setRouteHash } from './react-workbench-controller.ts'

type ChannelSnapshot = Pick<
  ChannelsGatewaySurfaceProps,
  'providers' | 'agents' | 'bindings' | 'people' | 'deliveries' | 'watches'
>

const EMPTY_CHANNEL_SNAPSHOT: ChannelSnapshot = {
  providers: [],
  agents: [],
  bindings: [],
  people: [],
  deliveries: [],
  watches: [],
}

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function listFromBody<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[]
  const value = asRecord(body)[key]
  return Array.isArray(value) ? value as T[] : []
}

function isAccessDeniedError(error: unknown) {
  const record = asRecord(error)
  if (record.status === 401 || record.status === 403) return true
  return /(?:status 40[13]|forbidden|permission|admin)/i.test(errorMessage(error))
}

async function readChannelList<T>(
  request: () => Promise<unknown>,
  key: string,
  options: { allowAccessDenied?: boolean } = {},
) {
  try {
    return listFromBody<T>(await request(), key)
  } catch (error) {
    if (options.allowAccessDenied && isAccessDeniedError(error)) return []
    throw error
  }
}

function itemFromBody<T>(body: unknown, key: string): T | null {
  const value = asRecord(body)[key]
  return value && typeof value === 'object' ? value as T : null
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function currentRole(workspace: unknown, bootstrap: CloudWebClientBootstrap) {
  const record = asRecord(workspace)
  const principal = asRecord(record.principal)
  return text(record.role || principal.role || bootstrap.role, 'member')
}

function canManageChannels(role: string) {
  return role === 'owner' || role === 'admin'
}

function channelHaystack(value: unknown) {
  const record = asRecord(value)
  return [
    record.id,
    record.agentId,
    record.bindingId,
    record.identityId,
    record.deliveryId,
    record.name,
    record.profileName,
    record.provider,
    record.displayName,
    record.status,
    record.externalWorkspaceId,
    record.externalUserId,
    record.eventType,
    record.channelBindingId,
    asRecord(record.target).id,
    asRecord(record.target).kind,
  ].filter(Boolean).join(' ').toLowerCase()
}

function matchesFilter(value: unknown, filter: string) {
  const tokens = filter.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const haystack = channelHaystack(value)
  return tokens.every((token) => haystack.includes(token))
}

function filterList<T>(values: T[], filter: string) {
  return values.filter((value) => matchesFilter(value, filter))
}

function withWorkspace(input: CoordinationWatchInput, workspace: unknown): CoordinationWatchInput {
  const workspaceId = text(asRecord(workspace).workspaceId || asRecord(workspace).id)
  return workspaceId ? { ...input, workspaceId } : input
}

export function CloudChannelSurfacePortals({
  bootstrap,
  workspace,
  onSelectSession,
}: {
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
  onSelectSession: (sessionId: string) => Promise<void>
}) {
  const api = useAppApi()
  const [snapshot, setSnapshot] = useState<ChannelSnapshot>(EMPTY_CHANNEL_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const target = usePortalTarget('channel-gateway-surface')
  const role = currentRole(workspace, bootstrap)
  const canManage = canManageChannels(role)
  const manageDisabledReason = 'Admin permissions are required for channel setup.'

  const loadChannels = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [
        providers,
        agents,
        bindings,
        people,
        deliveries,
        watches,
      ] = await Promise.all([
        canManage
          ? readChannelList<ChannelProviderStatus>(() => api.channels.providers(), 'providers')
          : Promise.resolve<ChannelProviderStatus[]>([]),
        canManage
          ? readChannelList<ChannelAgentRecord>(() => api.channels.agents(), 'agents')
          : Promise.resolve<ChannelAgentRecord[]>([]),
        canManage
          ? readChannelList<ChannelBindingPublicRecord>(() => api.channels.bindings(), 'bindings')
          : Promise.resolve<ChannelBindingPublicRecord[]>([]),
        canManage
          ? readChannelList<ChannelIdentityPublicRecord>(() => api.channels.people(), 'identities')
          : Promise.resolve<ChannelIdentityPublicRecord[]>([]),
        readChannelList<ChannelDeliveryPublicRecord>(() => api.channels.deliveries(), 'deliveries', { allowAccessDenied: !canManage }),
        readChannelList<CoordinationWatch>(() => api.channels.watches(), 'watches', { allowAccessDenied: !canManage }),
      ])
      setSnapshot({
        providers,
        agents,
        bindings,
        people,
        deliveries,
        watches,
      })
    } catch (loadError) {
      setError(errorMessage(loadError))
      setSnapshot(EMPTY_CHANNEL_SNAPSHOT)
    } finally {
      setLoading(false)
    }
  }, [api.channels, canManage])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  useEffect(() => {
    const control = document.getElementById('channel-filter') as HTMLInputElement | null
    const syncFilter = () => {
      setFilter(control?.value || '')
    }
    control?.addEventListener('input', syncFilter)
    control?.addEventListener('change', syncFilter)
    syncFilter()
    return () => {
      control?.removeEventListener('input', syncFilter)
      control?.removeEventListener('change', syncFilter)
    }
  }, [])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const clickTarget = event.target as HTMLElement | null
      if (!clickTarget?.closest('#refresh-channels')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void loadChannels()
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [loadChannels])

  const ensureChannelAgent = useCallback(async () => {
    const existing = snapshot.agents.find((agent) => agent.status === 'active')
    if (existing) return existing.agentId
    const body = await api.channels.createAgent({
      name: 'Gateway Channel Coworker',
      profileName: bootstrap.profileName || 'default',
      status: 'active',
      managed: true,
    })
    const agent = itemFromBody<ChannelAgentRecord>(body, 'agent')
    if (!agent?.agentId) throw new Error('Channel coworker creation did not return an agent id.')
    return agent.agentId
  }, [api.channels, bootstrap.profileName, snapshot.agents])

  const connectProvider = useCallback(async (provider: ChannelProviderKind) => {
    const agentId = await ensureChannelAgent()
    await api.channels.connectBinding({
      agentId,
      provider,
      displayName: `${channelProviderLabel(provider)} channel`,
      status: 'auth_required',
      settings: {},
    })
  }, [api.channels, ensureChannelAgent])

  const openThread = useCallback((sessionId: string) => {
    setRouteHash('chat')
    void onSelectSession(sessionId)
  }, [onSelectSession])

  const filteredSnapshot = useMemo<ChannelSnapshot>(() => ({
    providers: filterList(snapshot.providers, filter),
    agents: filterList(snapshot.agents, filter),
    bindings: filterList(snapshot.bindings, filter),
    people: filterList(snapshot.people, filter),
    deliveries: filterList(snapshot.deliveries, filter),
    watches: filterList(snapshot.watches, filter),
  }), [filter, snapshot])

  if (!target) return null

  return createPortal(
    <ChannelsGatewaySurface
      {...filteredSnapshot}
      loading={loading}
      error={error}
      canManage={canManage}
      manageDisabledReason={manageDisabledReason}
      platformLabel={`Cloud Web - ${role}`}
      allowProviderFallback={!filter.trim()}
      onReload={loadChannels}
      onConnectProvider={connectProvider}
      onDisconnectBinding={(bindingId) => api.channels.disconnectBinding(bindingId)}
      onResolvePerson={(input) => api.channels.resolvePerson(input)}
      onCreateWatch={(input) => api.channels.createWatch(withWorkspace(input, workspace))}
      onPauseWatch={(watchId) => api.channels.pauseWatch(watchId)}
      onResumeWatch={(watchId) => api.channels.resumeWatch(watchId)}
      onDeleteWatch={(watchId) => api.channels.deleteWatch(watchId)}
      onOpenDeliverySession={openThread}
    />,
    target,
  )
}
