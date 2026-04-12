import type { BuiltInAgentDetail as BuiltInAgentDetailType } from '@cowork/shared'

function agentPillStyle(color?: string) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
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

export function BuiltInAgentDetail({ agent, onBack }: { agent: BuiltInAgentDetailType; onBack: () => void }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-8">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Agents
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={agentPillStyle(agent.color)}>
                {agent.label}
              </span>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle(agent.mode === 'primary' ? 'primary' : 'visible')}>
                {agent.mode === 'primary' ? 'Primary' : 'Sub-agent'}
              </span>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle(agent.hidden ? 'hidden' : 'visible')}>
                {agent.hidden ? 'Internal only' : agent.mode === 'primary' ? 'Top-level mode' : 'Visible in @mentions'}
              </span>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={badgeStyle('source')}>
                {agent.source === 'cowork' ? 'Cowork built-in' : 'OpenCode built-in'}
              </span>
            </div>
            <h1 className="text-[18px] font-semibold text-text mb-1">{agent.label}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">{agent.description}</p>
          </div>
          <div className="text-right text-[11px] text-text-muted shrink-0">
            <div>id: {agent.name}</div>
            <div className="mt-1">{agent.skills.length} skills</div>
            <div>{agent.toolScopes.length} tool scopes</div>
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4 mb-4">
          {sectionTitle('Tool scopes')}
          <div className="flex flex-wrap gap-2">
            {agent.toolScopes.map((tool) => (
              <span
                key={tool}
                className="px-2 py-1 rounded-lg text-[11px] text-text-secondary border border-border-subtle bg-elevated"
              >
                {tool}
              </span>
            ))}
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
            <div className="text-[12px] text-text-muted">This agent does not preload any Cowork skills.</div>
          )}
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          {sectionTitle('Instructions')}
          <div className="rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-[12px] text-text-secondary whitespace-pre-wrap leading-relaxed">
            {agent.instructions}
          </div>
        </div>
      </div>
    </div>
  )
}
