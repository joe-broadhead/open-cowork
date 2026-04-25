import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CustomAgentConfig, CustomMcpConfig, CustomSkillConfig, RuntimeContextOptions, RuntimeToolDescriptor } from '@open-cowork/shared'
import { CustomMcpForm } from '../plugins/CustomMcpForm'
import { CustomSkillForm } from '../plugins/CustomSkillForm'
import { useSessionStore } from '../../stores/session'
import { confirmMcpRemoval, confirmSkillRemoval } from '../../helpers/destructive-actions'
import { SkillSelectionCard, ToolSelectionCard } from './CapabilitySelectionCard'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'

type Tab = 'tools' | 'skills'
type Selection =
  | { type: 'tool'; id: string }
  | { type: 'skill'; name: string }
  | null

function stripFrontmatter(content: string) {
  return content.replace(/^---[\s\S]*?---\n?/, '').trim()
}

function prettyKind(tool: CapabilityTool) {
  if (tool.origin === 'opencode') return t('capabilities.kindOpencodeTool', 'OpenCode tool')
  if (tool.source === 'custom') return t('capabilities.kindCustomMcp', 'Custom MCP')
  return tool.kind === 'built-in' ? t('capabilities.kindBuiltinTool', 'Built-in tool') : t('capabilities.kindMcpTool', 'MCP tool')
}

function prettySkillKind(skill: CapabilitySkill) {
  if (skill.source === 'custom') return t('capabilities.kindCustomSkill', 'Custom skill')
  return t('capabilities.kindBuiltinSkill', 'Built-in skill')
}

function prettySkillSource(skill: CapabilitySkill) {
  if (skill.origin === 'open-cowork') return t('capabilities.skillSourceBundled', '{{brand}} bundled skill', { brand: getBrandName() })
  if (skill.scope === 'project') return t('capabilities.skillSourceProject', 'Project skill')
  if (skill.scope === 'machine') return t('capabilities.skillSourceMachine', 'Machine skill')
  return t('capabilities.skillSourceBundle', 'Skill bundle')
}

function toolPrefixes(tool: CapabilityTool) {
  const prefixes = new Set<string>()

  if (tool.namespace) {
    prefixes.add(`mcp__${tool.namespace}__`)
    prefixes.add(`${tool.namespace}_`)
  }

  prefixes.add(`mcp__${tool.id}__`)
  prefixes.add(`${tool.id}_`)

  return Array.from(prefixes)
}

function safeText(value: string | null | undefined) {
  return typeof value === 'string' ? value : ''
}

function mergedRuntimeToolset(tool: CapabilityTool, runtimeTools: RuntimeToolDescriptor[]) {
  const prefixes = toolPrefixes(tool)
  const discovered = runtimeTools.filter((entry) => {
    const id = entry.id || entry.name || ''
    return id === tool.id || prefixes.some((prefix) => id.startsWith(prefix))
  })

  if (discovered.length > 0) {
    return discovered.map((entry) => ({
      id: entry.id || entry.name || 'unknown',
      description: entry.description || 'No description available for this MCP method.',
    }))
  }

  return tool.availableTools || []
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">{label}</div>
      <div className="text-[12px] text-text-secondary break-all">{value}</div>
    </div>
  )
}

function EmptyGrid({ message }: { message: string }) {
  return (
    <div className="text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
      {message}
    </div>
  )
}

// One row in the skill bundle's file list. Lazy-loads the file body
// on click via `settings.capabilities.skillBundleFile(...)` — avoids
// bloating the initial `skill-bundle` payload for skills that ship
// with large reference docs or scripts the user may never open.
function SkillBundleFileEntry({
  skillName,
  filePath,
  context,
}: {
  skillName: string
  filePath: string
  context: RuntimeContextOptions | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (content !== null) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.coworkApi.capabilities.skillBundleFile(skillName, filePath, context)
      setContent(result ?? '')
      if (result == null) setError('File content unavailable.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const isMarkdown = /\.(md|markdown)$/i.test(filePath)

  return (
    <div className="rounded-xl border border-border-subtle bg-elevated">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-3 text-start cursor-pointer"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-text-muted shrink-0 transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <polyline points="4,2 8,6 4,10" />
        </svg>
        <span className="text-[12px] font-medium text-text flex-1 truncate">{filePath}</span>
      </button>
      {expanded ? (
        <div className="px-3 pb-3 border-t border-border-subtle pt-3">
          {loading ? (
            <div className="text-[11px] text-text-muted">{t('capabilities.bundleFileLoading', 'Loading…')}</div>
          ) : error ? (
            <div className="text-[11px] text-red">{error}</div>
          ) : isMarkdown ? (
            // `min-w-0` so the flex/grid parent doesn't let the prose box
            // expand to fit the widest child; `overflow-x-auto` gives
            // tables + long code blocks their own horizontal scroll inside
            // the bundle card rather than pushing the card wider than its
            // container. Scoped CSS on the markdown primitives takes care
            // of the common overflow offenders.
            <div className="min-w-0 max-w-full overflow-x-auto">
              <div className="prose prose-invert max-w-none text-[12px] text-text-secondary leading-relaxed [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:break-words [&_p]:break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-all font-mono">{content || ''}</pre>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// Per-MCP credential form surfaced in the Capabilities detail panel.
// Reads the currently stored (masked) values from `settings.getWithCredentials`,
// lets the user overwrite them, and persists through `settings.set` —
// the same bag (`integrationCredentials[mcpName][key]`) that
// `envSettings` / `headerSettings` read from at runtime. No shell env
// vars involved; everything the user needs to connect an MCP lives in
// the UI.
function ToolCredentialsCard({
  integrationId,
  credentials,
}: {
  integrationId: string
  credentials: NonNullable<CapabilityTool['credentials']>
}) {
  const [stored, setStored] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.coworkApi.settings.getWithCredentials()
      .then((settings) => {
        if (cancelled) return
        const current = settings.integrationCredentials?.[integrationId] || {}
        setStored(current)
        setDrafts({})
      })
      .catch((err) => {
        console.error('Failed to load stored integration credentials:', err)
      })
    return () => { cancelled = true }
  }, [integrationId])

  const dirty = Object.keys(drafts).some((key) => drafts[key] !== undefined && drafts[key] !== '')

  async function handleSave() {
    if (!dirty || saving) return
    setSaving(true)
    setErrorMessage(null)
    try {
      // Only forward fields the user touched. Empty strings explicitly
      // clear a stored credential (by passing '' through settings.set).
      const patch: Record<string, string> = {}
      for (const credential of credentials) {
        const draft = drafts[credential.key]
        if (draft === undefined) continue
        patch[credential.key] = draft
      }
      await window.coworkApi.settings.set({
        integrationCredentials: {
          [integrationId]: patch,
        },
      })
      const refreshed = await window.coworkApi.settings.getWithCredentials()
      setStored(refreshed.integrationCredentials?.[integrationId] || {})
      setDrafts({})
      setSavedAt(Date.now())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {t('capabilities.credentials', 'Credentials')}
        </div>
        {savedAt ? (
          <span className="text-[10px] text-text-muted">{t('capabilities.credentialsSaved', 'Saved')}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {credentials.map((credential) => {
          const hasStored = Boolean(stored[credential.key])
          const draft = drafts[credential.key]
          const value = draft !== undefined ? draft : (hasStored ? '••••••••' : '')
          return (
            <label key={credential.key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-text-secondary">
                {credential.label}{credential.required ? <span className="text-red ms-1">*</span> : null}
              </span>
              <input
                type={credential.secret ? 'password' : 'text'}
                value={value}
                placeholder={credential.placeholder || ''}
                onFocus={(event) => {
                  // Clear the mask placeholder on focus so the user
                  // doesn't accidentally persist the bullets.
                  if (draft === undefined && hasStored) {
                    setDrafts((current) => ({ ...current, [credential.key]: '' }))
                    event.currentTarget.value = ''
                  }
                }}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [credential.key]: event.target.value }))
                }}
                className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
                autoComplete="off"
                spellCheck={false}
              />
              {credential.description ? (
                <span className="text-[10px] text-text-muted leading-relaxed">{credential.description}</span>
              ) : null}
            </label>
          )
        })}
      </div>
      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-contrast, #fff)' }}
        >
          {saving ? t('capabilities.credentialsSaving', 'Saving…') : t('capabilities.credentialsSave', 'Save')}
        </button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-[11px]" style={{ color: 'var(--color-red)' }}>
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

// Per-integration enable toggle. Default behavior (undefined) differs
// by auth mode:
//   - `oauth` integrations are OFF by default — bundling an MCP the
//     user never asked about shouldn't produce a `needs_auth` noise
//     line in the boot log.
//   - `api_token` / `none` integrations are auto-enabled when their
//     prerequisites are met (credentials stored, Google sign-in, etc.).
// Flipping the toggle writes `integrationEnabled[integrationId]` —
// `true` forces on (will still skip if prereqs are missing, with a
// clearer CTA), `false` forces off even when prereqs are ready.
function ToolIntegrationToggleCard({
  integrationId,
  authMode,
  enabled,
}: {
  integrationId: string
  authMode: 'none' | 'oauth' | 'api_token'
  enabled: boolean | undefined
}) {
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Optimistic override: once the user clicks, the toggle flips
  // immediately even though the parent-fetched `enabled` prop is still
  // stale. The parent only re-fetches capabilities when the user
  // navigates to a new page — without this local state, the toggle
  // would stay visually stuck on the old position until that happens.
  // Reset whenever the prop changes (e.g. navigating between tools)
  // so we don't carry a stale override across integrations.
  const [localEnabled, setLocalEnabled] = useState<boolean | undefined>(enabled)
  useEffect(() => {
    setLocalEnabled(enabled)
    setErrorMessage(null)
  }, [enabled, integrationId])

  // `localEnabled` is the source of truth once the user flips; the
  // credential-presence probe only pre-positions the toggle for
  // `api_token` integrations before any explicit choice. We intentionally
  // DON'T re-run this effect on toggle clicks — credentials aren't
  // touched by the enable/disable flow, and refetching every click is
  // wasted IPC. Re-run only when the user navigates to a new
  // integration.
  const [hasStoredCredentials, setHasStoredCredentials] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.coworkApi.settings.get().then((settings) => {
      if (cancelled) return
      const entries = settings.integrationCredentials?.[integrationId] || {}
      setHasStoredCredentials(Object.values(entries).some((value) => typeof value === 'string' && value.length > 0))
    }).catch((err) => {
      console.error('Failed to load integration credential readiness:', err)
    })
    return () => { cancelled = true }
  }, [integrationId])

  // Derive the effective on/off state for display. Explicit user
  // override wins; otherwise we reflect the main-process readiness
  // heuristic so the toggle shows the right position on first paint.
  const effectiveOn = localEnabled !== undefined
    ? localEnabled
    : authMode === 'oauth'
      ? false
      : authMode === 'api_token'
        ? hasStoredCredentials
        : true

  // Guard against two races:
  //   1. Component unmounts while the IPC is in flight — without this
  //      flag, a late resolve/reject would call setLocalEnabled on an
  //      unmounted component and React warns.
  //   2. User clicks into a different integration mid-flight — the
  //      captured `targetId` below differs from the current
  //      `integrationId`, so we skip applying any result to avoid
  //      writing the OLD tool's state into the NEW tool's UI.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  async function setEnabled(next: boolean) {
    if (pending) return
    const targetId = integrationId
    const previous = localEnabled
    setPending(true)
    setErrorMessage(null)
    setLocalEnabled(next)
    try {
      await window.coworkApi.settings.set({
        integrationEnabled: { [targetId]: next },
      })
    } catch (error) {
      if (mountedRef.current && targetId === integrationId) {
        setLocalEnabled(previous)
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  const helpText = authMode === 'oauth'
    ? t(
      'capabilities.integrationOAuthHelp',
      'Turn this on to sign in with the provider. Until you do, the integration is bundled but dormant — nothing runs and no status errors are reported.',
    )
    : authMode === 'api_token'
      ? t(
        'capabilities.integrationApiTokenHelp',
        'Enabled once you save an API key below. You can force-disable to hide it entirely.',
      )
      : t(
        'capabilities.integrationNoneHelp',
        'Bundled infrastructure. Disable only if you really want to turn it off for this install.',
      )

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t('capabilities.integrationStatus', 'Integration')}
          </div>
          <div className="text-[12px] text-text-primary">
            {effectiveOn
              ? t('capabilities.integrationOn', 'Enabled')
              : t('capabilities.integrationOff', 'Disabled')}
          </div>
          <div className="text-[10px] text-text-muted leading-relaxed">{helpText}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveOn}
          disabled={pending}
          onClick={() => { void setEnabled(!effectiveOn) }}
          className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          style={effectiveOn
            ? { background: 'var(--color-surface-active)', color: 'var(--color-text-secondary)' }
            : { background: 'var(--color-accent)', color: 'var(--color-accent-contrast, #fff)' }}
        >
          {effectiveOn
            ? t('capabilities.integrationDisableCta', 'Disable')
            : authMode === 'oauth'
              ? t('capabilities.integrationEnableOAuthCta', 'Enable & sign in')
              : t('capabilities.integrationEnableCta', 'Enable')}
        </button>
      </div>
      {errorMessage ? (
        <div className="mt-3 text-[11px] text-red" role="alert">
          {t('capabilities.integrationToggleFailed', 'Couldn’t update this integration:')} {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

function suggestAgentId(value: string) {
  return `${value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new'}-agent`
}

function buildAgentSeedFromTool(tool: CapabilityTool): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(tool.id),
    description: tool.description,
    toolIds: [tool.id],
    instructions: '',
    skillNames: [],
    enabled: true,
    color: 'accent',
  }
}

function buildAgentSeedFromSkill(skill: CapabilitySkill): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(skill.name),
    description: skill.description,
    toolIds: [...(skill.toolIds || [])],
    instructions: '',
    skillNames: [skill.name],
    enabled: true,
    color: 'accent',
  }
}

export function CapabilitiesPage({
  onClose,
  onCreateAgent,
}: {
  onClose: () => void
  onCreateAgent: (seed: Partial<CustomAgentConfig>) => void
}) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const [tab, setTab] = useState<Tab>('tools')
  const [search, setSearch] = useState('')
  const [tools, setTools] = useState<CapabilityTool[]>([])
  const [skills, setSkills] = useState<CapabilitySkill[]>([])
  const [customMcps, setCustomMcps] = useState<CustomMcpConfig[]>([])
  const [customSkills, setCustomSkills] = useState<CustomSkillConfig[]>([])
  // Each pair drives one form surface. `null` hides it; `'new'` opens a
  // blank form; a CustomMcpConfig / CustomSkillConfig opens the form in
  // edit mode seeded with that bundle's current state.
  const [mcpForm, setMcpForm] = useState<'new' | CustomMcpConfig | null>(null)
  const [skillForm, setSkillForm] = useState<'new' | CustomSkillConfig | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolDescriptor[]>([])
  const [selectedToolDetail, setSelectedToolDetail] = useState<CapabilityTool | null>(null)
  const [selectedSkillBundle, setSelectedSkillBundle] = useState<CapabilitySkillBundle | null>(null)

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )
  const toolOptions = useMemo(
    () => currentSessionId ? { sessionId: currentSessionId } : undefined,
    [currentSessionId],
  )
  const contextOptions = useMemo(
    () => currentProjectDirectory ? { directory: currentProjectDirectory } : undefined,
    [currentProjectDirectory],
  )

  const loadAll = () => {
    window.coworkApi.capabilities.tools(toolOptions).then(setTools)
    window.coworkApi.capabilities.skills(contextOptions).then(setSkills)
    window.coworkApi.custom.listMcps(contextOptions).then(setCustomMcps)
    window.coworkApi.custom.listSkills(contextOptions).then(setCustomSkills)
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }

  useEffect(() => {
    loadAll()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadAll())
    return unsubscribe
  }, [currentSessionId, currentProjectDirectory])

  useEffect(() => {
    if (selection?.type !== 'tool') {
      setSelectedToolDetail(null)
      return
    }

    window.coworkApi.capabilities.tool(selection.id, toolOptions).then(setSelectedToolDetail).catch(() => setSelectedToolDetail(null))
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }, [selection, toolOptions])

  useEffect(() => {
    if (selection?.type !== 'skill') {
      setSelectedSkillBundle(null)
      return
    }

    window.coworkApi.capabilities.skillBundle(selection.name, contextOptions).then(setSelectedSkillBundle).catch(() => setSelectedSkillBundle(null))
  }, [selection, contextOptions])

  const filteredTools = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tools
    return tools.filter((tool) => (
      safeText(tool.name).toLowerCase().includes(query)
      || safeText(tool.description).toLowerCase().includes(query)
      || (tool.agentNames || []).some((agent) => safeText(agent).toLowerCase().includes(query))
    ))
  }, [search, tools])

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return skills
    return skills.filter((skill) => (
      safeText(skill.label).toLowerCase().includes(query)
      || safeText(skill.description).toLowerCase().includes(query)
      || (skill.agentNames || []).some((agent) => safeText(agent).toLowerCase().includes(query))
    ))
  }, [search, skills])

  const selectedTool = selection?.type === 'tool'
    ? selectedToolDetail || tools.find((tool) => tool.id === selection.id) || null
    : null
  const selectedSkill = selection?.type === 'skill'
    ? skills.find((skill) => skill.name === selection.name) || null
    : null
  const toolNameById = useMemo(
    () => new Map(tools.map((tool) => [tool.id, tool.name])),
    [tools],
  )

  if (mcpForm) {
    return (
      <CustomMcpForm
        projectDirectory={currentProjectDirectory}
        existing={mcpForm === 'new' ? null : mcpForm}
        onSave={() => { setMcpForm(null); loadAll() }}
        onCancel={() => setMcpForm(null)}
      />
    )
  }

  if (skillForm) {
    return (
      <CustomSkillForm
        projectDirectory={currentProjectDirectory}
        existing={skillForm === 'new' ? null : skillForm}
        onSave={() => { setSkillForm(null); loadAll() }}
        onCancel={() => setSkillForm(null)}
      />
    )
  }

  if (selectedTool) {
    const custom = customMcps.find((entry) => entry.name === selectedTool.id) || null
    const availableTools = mergedRuntimeToolset(selectedTool, runtimeTools)

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-8 py-8">
          <button onClick={() => setSelection(null)} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
            Capabilities
          </button>

          <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>
                    {prettyKind(selectedTool)}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{
                    color: selectedTool.source === 'custom' ? 'var(--color-amber)' : 'var(--color-green)',
                    background: selectedTool.source === 'custom'
                      ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                      : 'color-mix(in srgb, var(--color-green) 12%, transparent)',
                  }}>
                    {selectedTool.source === 'custom' ? 'Installed' : 'Built-in'}
                  </span>
                </div>
                <h1 className="text-[20px] font-semibold text-text mb-1">{selectedTool.name}</h1>
                <p className="text-[13px] text-text-secondary leading-relaxed">{selectedTool.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onCreateAgent(buildAgentSeedFromTool(selectedTool))}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                >
                  Create agent
                </button>
                {custom ? (
                  <>
                    <button
                      onClick={() => setMcpForm(custom)}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                    >
                      Edit tool
                    </button>
                    <button
                      onClick={async () => {
                        const target = {
                          name: custom.name,
                          scope: custom.scope,
                          directory: custom.directory || null,
                        } as const
                        const confirmation = await confirmMcpRemoval(target)
                        if (!confirmation) return
                        const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
                        if (!ok) return
                        setSelection(null)
                        loadAll()
                      }}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                    >
                      Remove tool
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.details', 'Details')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <StatBox label="Identifier" value={selectedTool.id} />
                  <StatBox
                    label="Source"
                    value={selectedTool.origin === 'opencode'
                      ? 'OpenCode runtime'
                      : selectedTool.source === 'custom'
                        ? (custom?.label?.trim() || custom?.name || 'Custom MCP')
                        : `${getBrandName()} config`}
                  />
                  <StatBox label="Runtime namespace" value={selectedTool.namespace || selectedTool.id} />
                  <StatBox label="Used by agents" value={selectedTool.agentNames.length > 0 ? selectedTool.agentNames.join(', ') : 'No agents yet'} />
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                    {selectedTool.origin === 'opencode' ? 'Runtime metadata' : 'Available methods'}
                  </div>
                  <span className="text-[10px] text-text-muted">
                    {selectedTool.origin === 'opencode' ? `${availableTools.length} entries` : `${availableTools.length} methods`}
                  </span>
                </div>
                {availableTools.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {availableTools.map((entry) => (
                      <div key={entry.id} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                        <div className="text-[12px] font-medium text-text">{entry.id}</div>
                        <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">
                    {selectedTool.origin === 'opencode'
                      ? 'No runtime metadata is available for this tool yet.'
                      : 'No MCP methods have been discovered for this tool yet.'}
                  </div>
                )}
              </div>

              {custom ? (
                <div className="rounded-xl border border-border-subtle bg-surface p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.connection', 'Connection')}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <StatBox label="Type" value={custom.type === 'stdio' ? 'Local stdio MCP' : 'Remote HTTP / SSE MCP'} />
                    {custom.type === 'stdio' ? (
                      <StatBox label="Command" value={custom.command || 'Not set'} />
                    ) : (
                      <StatBox label="Endpoint" value={custom.url || 'Not set'} />
                    )}
                  </div>
                </div>
              ) : null}

              {selectedTool.integrationId && selectedTool.authMode ? (
                <ToolIntegrationToggleCard
                  integrationId={selectedTool.integrationId}
                  authMode={selectedTool.authMode}
                  enabled={selectedTool.enabled}
                />
              ) : null}

              {selectedTool.credentials && selectedTool.credentials.length > 0 && selectedTool.integrationId ? (
                <ToolCredentialsCard
                  integrationId={selectedTool.integrationId}
                  credentials={selectedTool.credentials}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.linkedAgents', 'Linked agents')}</div>
                {selectedTool.agentNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedTool.agentNames.map((agentName) => (
                      <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {agentName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">No built-in or custom agents use this tool yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (selectedSkill) {
    const custom = customSkills.find((entry) => entry.name === selectedSkill.name) || null
    const bundle = selectedSkillBundle || null
    const linkedToolNames = (selectedSkill.toolIds || []).map((toolId) => toolNameById.get(toolId) || toolId)

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-8 py-8">
          <button onClick={() => setSelection(null)} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
            Capabilities
          </button>

          <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{
                    color: selectedSkill.source === 'custom'
                      ? 'var(--color-amber)'
                      : 'var(--color-accent)',
                    background: selectedSkill.source === 'custom'
                      ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                      : 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                  }}>
                    {prettySkillKind(selectedSkill)}
                  </span>
                </div>
                <h1 className="text-[20px] font-semibold text-text mb-1">{selectedSkill.label}</h1>
                <p className="text-[13px] text-text-secondary leading-relaxed">{selectedSkill.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onCreateAgent(buildAgentSeedFromSkill(selectedSkill))}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                >
                  Create agent
                </button>
                {custom ? (
                  <>
                    <button
                      onClick={() => setSkillForm(custom)}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                    >
                      Edit skill
                    </button>
                    <button
                      onClick={async () => {
                        const target = {
                          name: custom.name,
                          scope: custom.scope,
                          directory: custom.directory || null,
                        } as const
                        const confirmation = await confirmSkillRemoval(target)
                        if (!confirmation) return
                        const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
                        if (!ok) return
                        setSelection(null)
                        loadAll()
                      }}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                    >
                      Remove skill
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 min-w-0">
            <div className="rounded-xl border border-border-subtle bg-surface p-4 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.skillContent', 'Skill Content')}</div>
              {bundle?.content ? (
                <div className="min-w-0 max-w-full overflow-x-auto">
                  <div className="prose prose-invert max-w-none text-[12px] text-text-secondary leading-relaxed [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:break-words [&_p]:break-words">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {stripFrontmatter(bundle.content)}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">{t('capabilities.noSkillContent', 'No skill bundle content is available yet.')}</div>
              )}
            </div>

            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.details', 'Details')}</div>
                <div className="flex flex-col gap-3">
                  <StatBox label="Identifier" value={selectedSkill.name} />
                  <StatBox label="Source" value={prettySkillSource(selectedSkill)} />
                  {selectedSkill.location ? (
                    <StatBox label="Location" value={selectedSkill.location} />
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.linkedTools', 'Linked tools')}</div>
                {linkedToolNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {linkedToolNames.map((toolName) => (
                      <span key={toolName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {toolName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">{t('capabilities.skillNotTiedToTool', 'This skill is not tied to a specific tool.')}</div>
                )}
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.usedByAgents', 'Used by agents')}</div>
                {selectedSkill.agentNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedSkill.agentNames.map((agentName) => (
                      <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {agentName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">No built-in or custom agents use this skill yet.</div>
                )}
              </div>

              {bundle?.files.length ? (
                <div className="rounded-xl border border-border-subtle bg-surface p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">{t('capabilities.bundleFiles', 'Bundle files')}</div>
                    <span className="text-[10px] text-text-muted">{bundle.files.length} files</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {bundle.files.map((file) => (
                      <SkillBundleFileEntry
                        key={file.path}
                        skillName={selectedSkill.name}
                        filePath={file.path}
                        context={contextOptions}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">{t('capabilities.title', 'Capabilities')}</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              {t('capabilities.subtitle', 'Inspect the tools and skill bundles available in the current OpenCode context, including bundled, machine, project, and custom additions.')}
            </p>
          </div>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">{t('agentsPage.backToChat', 'Back to chat')}</button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tab === 'tools' ? t('capabilities.searchTools', 'Search tools, descriptions, or agents…') : t('capabilities.searchSkills', 'Search skills, descriptions, or agents…')}
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['tools', 'skills'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${tab === value ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {value === 'tools' ? t('capabilities.tab.tools', 'Tools') : t('capabilities.tab.skills', 'Skills')}
              </button>
            ))}
          </div>
          <button
            onClick={() => tab === 'tools' ? setMcpForm('new') : setSkillForm('new')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" />
            </svg>
            {tab === 'tools' ? t('capabilities.addTool', 'Add tool') : t('capabilities.addSkillButton', 'Add skill')}
          </button>
        </div>

        {tab === 'tools' ? (
          filteredTools.length === 0 ? (
            <EmptyGrid message={tools.length === 0
              ? t('capabilities.noToolsDiscovered', 'No tools discovered yet. Add a custom MCP to extend the runtime.')
              : t('capabilities.noToolsMatch', 'No tools matched your search.')} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredTools.map((tool) => {
                const custom = customMcps.find((entry) => entry.name === tool.id)
                const availableCount = mergedRuntimeToolset(tool, runtimeTools).length
                return (
                  <ToolSelectionCard
                    key={tool.id}
                    tool={tool}
                    methodsCount={availableCount}
                    isCustom={Boolean(custom)}
                    onOpen={() => setSelection({ type: 'tool', id: tool.id })}
                    onRemove={custom
                      ? async () => {
                          const target = {
                            name: custom.name,
                            scope: custom.scope,
                            directory: custom.directory || null,
                          } as const
                          const confirmation = await confirmMcpRemoval(target)
                          if (!confirmation) return
                          const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
                          if (!ok) return
                          loadAll()
                        }
                      : undefined}
                  />
                )
              })}
            </div>
          )
        ) : (
          filteredSkills.length === 0 ? (
            <EmptyGrid message={skills.length === 0
              ? t('capabilities.noSkillsDiscovered', 'No skills discovered yet. Add a custom skill bundle to extend agents.')
              : t('capabilities.noSkillsMatch', 'No skills matched your search.')} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredSkills.map((skill) => {
                const custom = customSkills.find((entry) => entry.name === skill.name)
                return (
                  <SkillSelectionCard
                    key={skill.name}
                    skill={skill}
                    isCustom={Boolean(custom)}
                    onOpen={() => setSelection({ type: 'skill', name: skill.name })}
                    onRemove={custom
                      ? async () => {
                          const target = {
                            name: custom.name,
                            scope: custom.scope,
                            directory: custom.directory || null,
                          } as const
                          const confirmation = await confirmSkillRemoval(target)
                          if (!confirmation) return
                          const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
                          if (!ok) return
                          loadAll()
                        }
                      : undefined}
                  />
                )
              })}
            </div>
          )
        )}
      </div>
    </div>
  )
}
