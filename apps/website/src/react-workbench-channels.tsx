import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import { asRecord, errorMessage, setRouteHash } from './react-workbench-controller.ts'

type ChannelAgent = {
  agentId?: string
  name?: string
  profileName?: string
  status?: string
  managed?: boolean
}

type ChannelBinding = {
  bindingId?: string
  agentId?: string
  provider?: string
  displayName?: string
  status?: string
  externalWorkspaceId?: string | null
}

type ChannelDelivery = {
  deliveryId?: string
  provider?: string
  channelBindingId?: string
  status?: string
  eventType?: string
  attemptCount?: number
  nextAttemptAt?: string
  updatedAt?: string
  sessionId?: string
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

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

function formatDate(value: unknown) {
  if (!value) return 'never'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function rowId(record: Record<string, unknown>, fallback: string) {
  return text(record.id || record.agentId || record.bindingId || record.deliveryId || record.sessionId, fallback)
}

function channelPillKind(status: unknown) {
  const value = String(status || '').toLowerCase()
  if (value === 'active' || value === 'sent' || value === 'delivered' || value === 'completed') return 'ok'
  if (value === 'pending' || value === 'queued' || value === 'auth_required' || value === 'retrying') return 'warn'
  if (value === 'failed' || value === 'dead' || value === 'error' || value === 'disabled') return 'warn'
  return ''
}

function channelAgentName(agents: ChannelAgent[], agentId: unknown) {
  const id = text(agentId)
  return agents.find((agent) => agent.agentId === id)?.name || id || 'unassigned coworker'
}

function channelBindingLabel(bindings: ChannelBinding[], bindingId: unknown) {
  const id = text(bindingId)
  const binding = bindings.find((entry) => entry.bindingId === id)
  return binding?.displayName || id || 'unbound channel'
}

function channelHaystack(value: unknown) {
  const record = asRecord(value)
  return [
    rowId(record, ''),
    record.name,
    record.profileName,
    record.provider,
    record.displayName,
    record.status,
    record.externalWorkspaceId,
    record.eventType,
    record.channelBindingId,
    record.sessionId,
  ].filter(Boolean).join(' ').toLowerCase()
}

function matchesChannelFilter(value: unknown, filter: string) {
  const tokens = filter.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const haystack = channelHaystack(value)
  return tokens.every((token) => haystack.includes(token))
}

function ChannelSummary({
  agents,
  bindings,
  deliveries,
  error,
}: {
  agents: ChannelAgent[]
  bindings: ChannelBinding[]
  deliveries: ChannelDelivery[]
  error: string | null
}) {
  const activeBindings = bindings.filter((binding) => String(binding.status || '').toLowerCase() === 'active').length
  const blockedDeliveries = deliveries.filter((delivery) => ['failed', 'dead', 'error'].includes(String(delivery.status || '').toLowerCase())).length
  return (
    <>
      {error ? <p className="notice">{error}</p> : null}
      <div className="row compact"><strong>Channel coworkers</strong><span>{agents.length}</span></div>
      <div className="row compact"><strong>Connected channels</strong><span>{bindings.length}</span></div>
      <div className="row compact"><strong>Active channels</strong><span>{activeBindings}</span></div>
      <div className="row compact"><strong>Recent updates</strong><span>{deliveries.length}</span></div>
      <div className="row compact"><strong>Needs attention</strong><span>{blockedDeliveries}</span></div>
      <p className="empty">This read-only user view focuses on channel reach, delivery status, and linked chats.</p>
    </>
  )
}

function ChannelAgentRows({ agents }: { agents: ChannelAgent[] }) {
  if (!agents.length) return <p className="empty">No channel coworkers loaded.</p>
  return (
    <>
      {agents.map((agent, index) => (
        <div className="row compact" key={agent.agentId || agent.name || index}>
          <div>
            <strong>{agent.name || agent.agentId || 'Channel coworker'}</strong>
            <br />
            <small>{[agent.profileName || 'default profile', agent.managed ? 'managed' : 'manual'].join(' - ')}</small>
          </div>
          <span className="pill" data-kind={channelPillKind(agent.status)}>{agent.status || 'unknown'}</span>
        </div>
      ))}
    </>
  )
}

function ChannelBindingRows({ bindings, agents }: { bindings: ChannelBinding[], agents: ChannelAgent[] }) {
  if (!bindings.length) return <p className="empty">No connected channels loaded.</p>
  return (
    <>
      {bindings.map((binding, index) => (
        <div className="row compact" key={binding.bindingId || binding.displayName || index}>
          <div>
            <strong>{binding.displayName || binding.bindingId || 'Connected channel'}</strong>
            <br />
            <small>{[binding.provider || 'provider', binding.externalWorkspaceId || 'tenant-wide channel', channelAgentName(agents, binding.agentId)].join(' - ')}</small>
          </div>
          <span className="pill" data-kind={channelPillKind(binding.status)}>{binding.status || 'unknown'}</span>
        </div>
      ))}
    </>
  )
}

function ChannelDeliveryRows({
  deliveries,
  bindings,
  onOpenThread,
}: {
  deliveries: ChannelDelivery[]
  bindings: ChannelBinding[]
  onOpenThread: (sessionId: string) => void
}) {
  if (!deliveries.length) return <p className="empty">No channel deliveries loaded.</p>
  return (
    <>
      {deliveries.slice(0, 50).map((delivery, index) => {
        const sessionId = text(delivery.sessionId)
        return (
          <div className="row compact" key={delivery.deliveryId || index}>
            <div>
              <strong>{delivery.eventType || delivery.deliveryId || 'Channel delivery'}</strong>
              <br />
              <small>{[
                delivery.provider || 'provider',
                channelBindingLabel(bindings, delivery.channelBindingId),
                sessionId ? `chat ${sessionId}` : null,
                delivery.updatedAt ? `updated ${formatDate(delivery.updatedAt)}` : null,
              ].filter(Boolean).join(' - ')}</small>
            </div>
            <div className="row-actions">
              <span className="pill" data-kind={channelPillKind(delivery.status)}>{delivery.status || 'unknown'}</span>
              {sessionId ? <button type="button" onClick={() => onOpenThread(sessionId)}>Open chat</button> : null}
            </div>
          </div>
        )
      })}
    </>
  )
}

export function CloudChannelSurfacePortals({ onSelectSession }: { onSelectSession: (sessionId: string) => Promise<void> }) {
  const api = useAppApi()
  const [agents, setAgents] = useState<ChannelAgent[]>([])
  const [bindings, setBindings] = useState<ChannelBinding[]>([])
  const [deliveries, setDeliveries] = useState<ChannelDelivery[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const summaryTarget = usePortalTarget('channel-summary-list')
  const agentsTarget = usePortalTarget('channel-agent-list')
  const bindingsTarget = usePortalTarget('channel-binding-list')
  const deliveriesTarget = usePortalTarget('channel-delivery-list')

  const loadChannels = useCallback(async () => {
    setError(null)
    try {
      const [agentBody, bindingBody, deliveryBody] = await Promise.all([
        api.channels.agents(),
        api.channels.bindings(),
        api.channels.deliveries(),
      ])
      setAgents(list<ChannelAgent>(asRecord(agentBody).agents))
      setBindings(list<ChannelBinding>(asRecord(bindingBody).bindings))
      setDeliveries(list<ChannelDelivery>(asRecord(deliveryBody).deliveries))
    } catch (loadError) {
      setError(errorMessage(loadError))
      setAgents([])
      setBindings([])
      setDeliveries([])
    }
  }, [api])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  useEffect(() => {
    const control = document.getElementById('channel-filter') as HTMLInputElement | null
    const onInput = () => setFilter(control?.value || '')
    control?.addEventListener('input', onInput)
    setFilter(control?.value || '')
    return () => control?.removeEventListener('input', onInput)
  }, [])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('#refresh-channels')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void loadChannels()
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [loadChannels])

  const filteredAgents = useMemo(() => agents.filter((agent) => matchesChannelFilter(agent, filter)), [agents, filter])
  const filteredBindings = useMemo(() => bindings.filter((binding) => matchesChannelFilter(binding, filter)), [bindings, filter])
  const filteredDeliveries = useMemo(() => deliveries.filter((delivery) => matchesChannelFilter(delivery, filter)), [deliveries, filter])
  const openThread = useCallback((sessionId: string) => {
    setRouteHash('chat')
    void onSelectSession(sessionId)
  }, [onSelectSession])
  const portals = []

  if (summaryTarget) portals.push(createPortal(<ChannelSummary agents={agents} bindings={bindings} deliveries={deliveries} error={error} />, summaryTarget))
  if (agentsTarget) portals.push(createPortal(error ? <p className="notice">{error}</p> : <ChannelAgentRows agents={filteredAgents} />, agentsTarget))
  if (bindingsTarget) portals.push(createPortal(error ? <p className="notice">{error}</p> : <ChannelBindingRows bindings={filteredBindings} agents={agents} />, bindingsTarget))
  if (deliveriesTarget) portals.push(createPortal(error ? <p className="notice">{error}</p> : <ChannelDeliveryRows deliveries={filteredDeliveries} bindings={bindings} onOpenThread={openThread} />, deliveriesTarget))

  return <>{portals}</>
}
