import { useEffect, useMemo, useState } from 'react'
import type { AgentCatalog, CustomMcpConfig, CustomMcpTestResult } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

type Props = {
  catalog: AgentCatalog
  selectedToolIds: string[]
  deniedToolPatterns: string[]
  projectDirectory: string | null
  onTogglePattern: (pattern: string) => void
  readOnly?: boolean
}

type McpTestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; methods: Array<{ id: string; description: string }> }
  | { status: 'error'; message: string }

// Lets users narrow an attached custom MCP to a subset of its methods by
// denying specific tool ids. Methods are live-introspected the first time
// a row is expanded — cached in component state until re-mount. Only
// custom MCPs show here: built-in tools don't expose sub-method ids in the
// permission model, so there's nothing to restrict.
export function McpRestrictionPanel({
  catalog,
  selectedToolIds,
  deniedToolPatterns,
  projectDirectory,
  onTogglePattern,
  readOnly,
}: Props) {
  const selectedCustomMcps = useMemo(() => (
    catalog.tools.filter((tool) => tool.source === 'custom' && selectedToolIds.includes(tool.id))
  ), [catalog.tools, selectedToolIds])

  const [mcpConfigs, setMcpConfigs] = useState<CustomMcpConfig[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [introspection, setIntrospection] = useState<Record<string, McpTestState>>({})

  useEffect(() => {
    const options = projectDirectory ? { directory: projectDirectory } : undefined
    window.coworkApi.custom.listMcps(options)
      .then((mcps) => setMcpConfigs(mcps || []))
      .catch(() => setMcpConfigs([]))
  }, [projectDirectory])

  const ensureIntrospection = async (mcpId: string) => {
    if (introspection[mcpId]?.status === 'ready' || introspection[mcpId]?.status === 'loading') return
    const config = mcpConfigs.find((mcp) => mcp.name === mcpId)
    if (!config) {
      setIntrospection((current) => ({ ...current, [mcpId]: { status: 'error', message: 'MCP config not found.' } }))
      return
    }
    setIntrospection((current) => ({ ...current, [mcpId]: { status: 'loading' } }))
    try {
      const result: CustomMcpTestResult = await window.coworkApi.custom.testMcp(config)
      if (!result.ok) {
        setIntrospection((current) => ({
          ...current,
          [mcpId]: { status: 'error', message: result.error || 'Could not connect to this MCP.' },
        }))
        return
      }
      setIntrospection((current) => ({
        ...current,
        [mcpId]: { status: 'ready', methods: result.methods || [] },
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to introspect MCP methods.'
      setIntrospection((current) => ({ ...current, [mcpId]: { status: 'error', message } }))
    }
  }

  const toggleExpanded = (mcpId: string) => {
    const next = !expanded[mcpId]
    setExpanded((current) => ({ ...current, [mcpId]: next }))
    if (next) void ensureIntrospection(mcpId)
  }

  if (selectedCustomMcps.length === 0) return null

  return (
    <div className="mt-4 rounded-xl border border-border-subtle bg-surface overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border-subtle">
        <div className="text-[12px] font-semibold text-text">Restrict MCP methods</div>
        <div className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
          Block specific tool ids on this agent without removing the whole MCP. Useful for scoping an agent&apos;s role —
          e.g. attach GitHub but disable <span className="font-mono">delete_repo</span>.
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border-subtle">
        {selectedCustomMcps.map((tool) => {
          const state = introspection[tool.id] || { status: 'idle' }
          const prefix = `mcp__${tool.id}__`
          const deniedForMcp = deniedToolPatterns.filter((pattern) => pattern.startsWith(prefix))
          const isOpen = Boolean(expanded[tool.id])
          return (
            <div key={tool.id}>
              <button
                onClick={() => toggleExpanded(tool.id)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-surface-hover cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                  >
                    <polyline points="4,2 8,6 4,10" />
                  </svg>
                  <span className="text-[12px] font-medium text-text">{tool.name}</span>
                </div>
                <span className="text-[10px] text-text-muted">
                  {deniedForMcp.length > 0 ? `${deniedForMcp.length} restricted` : 'all methods allowed'}
                </span>
              </button>

              {isOpen ? (
                <div className="px-3 pb-3">
                  {state.status === 'loading' ? (
                    <div className="text-[11px] text-text-muted py-2">Discovering methods…</div>
                  ) : state.status === 'error' ? (
                    <ManualRestrictionFallback
                      mcpId={tool.id}
                      message={state.message}
                      deniedPatterns={deniedForMcp}
                      onRetry={() => void ensureIntrospection(tool.id)}
                      onTogglePattern={onTogglePattern}
                      readOnly={readOnly}
                    />
                  ) : state.status === 'ready' ? (
                    state.methods.length === 0 ? (
                      <div className="text-[11px] text-text-muted py-2">
                        This MCP didn&apos;t expose any methods.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {state.methods.map((method) => {
                          const pattern = `mcp__${tool.id}__${method.id}`
                          const isDenied = deniedToolPatterns.includes(pattern)
                          return (
                            <label
                              key={method.id}
                              className="flex items-start gap-2 text-[11px] cursor-pointer"
                              style={{ opacity: readOnly ? 0.6 : 1 }}
                            >
                              <input
                                type="checkbox"
                                checked={!isDenied}
                                disabled={readOnly}
                                onChange={() => !readOnly && onTogglePattern(pattern)}
                                className="mt-0.5"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-text">{method.id}</div>
                                {method.description ? (
                                  <div className="text-text-muted leading-relaxed">{method.description}</div>
                                ) : null}
                              </div>
                            </label>
                          )
                        })}
                      </div>
                    )
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Fallback surface when live introspection fails — typical for HTTP MCPs
// behind OAuth that reject unauthenticated `tools.list` calls. Users can
// still block specific methods by typing the method id; we prefix it with
// the MCP namespace so the pattern matches the runtime permission config.
function ManualRestrictionFallback({
  mcpId,
  message,
  deniedPatterns,
  onRetry,
  onTogglePattern,
  readOnly,
}: {
  mcpId: string
  message: string
  deniedPatterns: string[]
  onRetry: () => void
  onTogglePattern: (pattern: string) => void
  readOnly?: boolean
}) {
  const [input, setInput] = useState('')
  const prefix = `mcp__${mcpId}__`

  const submit = () => {
    const trimmed = input.trim()
    if (!trimmed) return
    const pattern = trimmed.startsWith('mcp__') ? trimmed : `${prefix}${trimmed}`
    if (!deniedPatterns.includes(pattern)) onTogglePattern(pattern)
    setInput('')
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--color-amber)' }}>
        Could not auto-discover methods: {message}
        <button onClick={onRetry} className="ml-2 underline cursor-pointer">Retry</button>
      </div>
      <div className="text-[10px] text-text-muted leading-relaxed">
        Common for MCPs behind OAuth. You can still block specific methods by id — type it below.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="e.g. delete_repo"
          disabled={readOnly}
          className="flex-1 px-2 py-1 rounded-md text-[11px] font-mono bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
        />
        <button
          onClick={submit}
          disabled={readOnly || !input.trim()}
          className="px-2.5 py-1 rounded-md text-[10px] font-medium border border-border-subtle text-accent cursor-pointer disabled:opacity-40"
        >
          Block
        </button>
      </div>
      {deniedPatterns.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {deniedPatterns.map((pattern) => (
            <button
              key={pattern}
              onClick={() => !readOnly && onTogglePattern(pattern)}
              disabled={readOnly}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] border cursor-pointer"
              style={{
                color: 'var(--color-amber)',
                background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
                borderColor: 'color-mix(in srgb, var(--color-amber) 40%, transparent)',
              }}
              title={t('mcpRestriction.removeRestriction', 'Click to remove this restriction')}
            >
              <span className="font-mono">{pattern.slice(prefix.length)}</span>
              <span>×</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
