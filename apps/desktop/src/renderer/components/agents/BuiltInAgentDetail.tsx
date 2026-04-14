import { useEffect, useMemo, useState } from 'react'
import type { BuiltInAgentDetail as BuiltInAgentDetailType, CapabilityTool } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'

function agentPillStyle(color?: string) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
      : color === 'info'
        ? 'var(--color-blue, #4da3ff)'
        : color === 'primary'
          ? 'var(--color-text)'
      : color === 'secondary'
        ? 'var(--color-text-secondary)'
        : 'var(--color-accent)'

  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 12%, transparent)`,
  }
}

function badgeStyle(kind: 'source' | 'primary' | 'visible' | 'hidden') {
  if (kind === 'source') {
    return {
      color: 'var(--color-accent)',
      background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
    }
  }

  if (kind === 'primary') {
    return {
      color: 'var(--color-text-secondary)',
      background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
    }
  }

  if (kind === 'hidden') {
    return {
      color: 'var(--color-amber)',
      background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
    }
  }

  return {
    color: 'var(--color-green)',
    background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
  }
}

function sectionTitle(label: string) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-2">{label}</div>
}

function iconStyle(color?: string) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
      : color === 'info'
        ? 'var(--color-blue, #4da3ff)'
        : color === 'primary'
          ? 'var(--color-text)'
      : color === 'secondary'
        ? 'var(--color-text-secondary)'
        : 'var(--color-accent)'

  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 14%, var(--color-elevated))`,
    borderColor: `color-mix(in srgb, ${tone} 20%, var(--color-border))`,
  }
}

function supportLabel(agent: BuiltInAgentDetailType) {
  return agent.hidden
    ? 'Internal'
    : agent.mode === 'primary'
      ? 'Top-level'
      : 'In chat'
}

function statCard(label: string, value: string) {
  return (
    <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">{label}</div>
      <div className="text-[12px] font-medium text-text">{value}</div>
    </div>
  )
}

type RuntimeToolInfo = {
  id?: string
  name?: string
  description?: string
}

function humanizeToolId(value: string) {
  if (value === 'websearch') return 'Web Search'
  if (value === 'webfetch') return 'Web Fetch'
  if (value === 'todowrite') return 'Todo Write'
  if (value === 'apply_patch') return 'Apply Patch'
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function BuiltInAgentDetail({ agent, onBack }: { agent: BuiltInAgentDetailType; onBack: () => void }) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolInfo[]>([])
  const [capabilityTools, setCapabilityTools] = useState<CapabilityTool[]>([])

  useEffect(() => {
    const options = currentSessionId ? { sessionId: currentSessionId } : undefined
    window.openCowork.tools
      .list(options)
      .then(setRuntimeTools)
      .catch(() => setRuntimeTools([]))
    window.openCowork.capabilities.tools(options).then(setCapabilityTools).catch(() => setCapabilityTools([]))
  }, [currentSessionId])

  const openCodeTools = useMemo(() => (
    agent.nativeToolIds.map((toolId) => {
      const runtimeTool = runtimeTools.find((entry) => (entry.id || entry.name) === toolId)
      return {
        id: toolId,
        name: humanizeToolId(toolId),
        description: runtimeTool?.description || 'Native OpenCode tool available to this agent.',
      }
    })
  ), [agent.nativeToolIds, runtimeTools])

  const configuredTools = useMemo(() => (
    agent.configuredToolIds
      .map((toolId) => capabilityTools.find((tool) => tool.id === toolId))
      .filter(Boolean) as CapabilityTool[]
  ), [agent.configuredToolIds, capabilityTools])

  const fallbackToolAccess = useMemo(() => {
    const resolved = new Set<string>([
      ...openCodeTools.map((tool) => tool.name),
      ...openCodeTools.map((tool) => tool.id),
      ...configuredTools.map((tool) => tool.name),
      ...configuredTools.map((tool) => tool.id),
    ])

    return agent.toolAccess.filter((label) => !resolved.has(label))
  }, [agent.toolAccess, configuredTools, openCodeTools])

  const toolCount = openCodeTools.length + configuredTools.length + fallbackToolAccess.length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-8">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Agents
        </button>

        <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
          <div className="flex items-start gap-4">
            <div
              className="w-14 h-14 rounded-2xl border flex items-center justify-center text-[22px] font-semibold shrink-0"
              style={iconStyle(agent.color)}
            >
              {agent.label.trim().charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={agentPillStyle(agent.color)}>
                  {agent.label}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle(agent.mode === 'primary' ? 'primary' : 'visible')}>
                  {agent.mode === 'primary' ? 'Top-level' : 'Sub-agent'}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle(agent.hidden ? 'hidden' : 'visible')}>
                  {supportLabel(agent)}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle('source')}>
                  {agent.source === 'open-cowork' ? 'Open Cowork built-in' : 'OpenCode built-in'}
                </span>
              </div>
              <h1 className="text-[18px] font-semibold text-text mb-1">{agent.label}</h1>
              <p className="text-[13px] text-text-secondary leading-relaxed">{agent.description}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {statCard('Agent ID', agent.name)}
          {statCard('Visibility', supportLabel(agent))}
          {statCard('Skill access', `${agent.skills.length} ${agent.skills.length === 1 ? 'skill' : 'skills'}`)}
          {statCard('Tool access', `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)}
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4 mb-4">
          {sectionTitle('How Open Cowork Uses This')}
              <div className="text-[12px] text-text-secondary leading-relaxed">
                {agent.mode === 'primary'
                  ? 'This is a top-level mode users can run directly from the chat mode toggle. It sets the overall working style for the thread.'
                  : agent.hidden
                ? 'This is an internal agent that Open Cowork may delegate to behind the scenes when a task needs this capability.'
                : 'This is a visible agent that Open Cowork can delegate to and users can invoke directly with @mentions.'}
              </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4 mb-4">
          {sectionTitle('Tools')}
          <div className="flex flex-col gap-3">
            {openCodeTools.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Native OpenCode tools</div>
                <div className="grid gap-2">
                  {openCodeTools.map((tool) => (
                    <div key={tool.id} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[12px] font-medium text-text">{tool.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-border-subtle text-text-muted">{tool.id}</span>
                      </div>
                      <div className="text-[11px] text-text-muted leading-relaxed">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {configuredTools.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Configured tools</div>
                <div className="grid gap-2">
                  {configuredTools.map((tool) => (
                    <div key={tool.id} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[12px] font-medium text-text">{tool.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-border-subtle text-text-muted">{tool.id}</span>
                      </div>
                      <div className="text-[11px] text-text-muted leading-relaxed">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {fallbackToolAccess.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Declared tool access</div>
                <div className="flex flex-wrap gap-2">
                  {fallbackToolAccess.map((label) => (
                    <span
                      key={label}
                      className="px-2 py-1 rounded-lg text-[11px] border border-border-subtle text-text-secondary bg-elevated"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4 mb-4">
          {sectionTitle('Skills')}
          {agent.skills.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {agent.skills.map((skill) => (
                <span
                  key={skill}
                  className="px-2 py-1 rounded-lg text-[11px] border border-border-subtle"
                  style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
                >
                  {skill}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-text-muted">This agent does not preload any bundled skills.</div>
          )}
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          {sectionTitle(agent.source === 'opencode' ? 'Behavior Source' : 'Instructions')}
          {agent.source === 'opencode' ? (
            <div className="rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-[12px] text-text-secondary leading-relaxed">
              This agent uses the native OpenCode built-in prompt and behavior. Open Cowork only shapes permissions,
              visibility, and UI metadata around it.
            </div>
          ) : (
            <div className="rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-[12px] text-text-secondary whitespace-pre-wrap leading-relaxed">
              {agent.instructions}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
