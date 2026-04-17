import { useEffect, useMemo, useState } from 'react'
import type { CustomMcpConfig, CustomMcpTestResult, CustomSkillConfig } from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { PluginIcon } from './PluginIcon'

const inputClass = 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function CustomMcpForm({
  onSave,
  onCancel,
  projectDirectory,
  existing,
}: {
  onSave: () => void
  onCancel: () => void
  projectDirectory?: string | null
  // When provided, the form opens in edit mode: fields pre-populated, the
  // name field is locked, the "already exists" guard is bypassed, and the
  // underlying save path overwrites the same on-disk bundle in place.
  existing?: CustomMcpConfig | null
}) {
  const isEditing = Boolean(existing)
  const [type, setType] = useState<'stdio' | 'http'>(existing?.type || 'stdio')
  const [scope, setScope] = useState<'machine' | 'project'>(
    existing?.scope || (projectDirectory ? 'project' : 'machine'),
  )
  const [projectTargetDirectory, setProjectTargetDirectory] = useState<string | null>(
    existing?.scope === 'project' ? existing?.directory || null : projectDirectory || null,
  )
  const [name, setName] = useState(existing?.name || '')
  const [label, setLabel] = useState(existing?.label || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [command, setCommand] = useState(existing?.command || '')
  const [args, setArgs] = useState((existing?.args || []).join(' '))
  const [url, setUrl] = useState(existing?.url || '')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>(
    existing?.env && Object.keys(existing.env).length > 0
      ? Object.entries(existing.env).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  )
  const [headerPairs, setHeaderPairs] = useState<Array<{ key: string; value: string }>>(
    existing?.headers && Object.keys(existing.headers).length > 0
      ? Object.entries(existing.headers).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  )
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [testResult, setTestResult] = useState<CustomMcpTestResult | null>(null)
  // Names of custom skills the user wants to pre-wire to this new MCP. On
  // save we fetch each selected skill, append this MCP's id to its
  // frontmatter `toolIds`, and save it back. Keeps the link unidirectional
  // (skill → tool) at the storage layer, same as built-in skills, while
  // letting the user complete the link from the tool side in the UI.
  const [linkedSkillNames, setLinkedSkillNames] = useState<string[]>([])
  const [availableSkills, setAvailableSkills] = useState<CustomSkillConfig[]>([])
  // Opt-in flag: inject the user's Google ADC path into the MCP subprocess
  // via GOOGLE_APPLICATION_CREDENTIALS. Only surfaced when the app is
  // configured with auth.mode: google-oauth — otherwise the toggle would
  // be a silent no-op. Stdio only (no env var for HTTP MCPs).
  const [googleAuthEnabled, setGoogleAuthEnabled] = useState(Boolean(existing?.googleAuth))
  const [authModeAvailable, setAuthModeAvailable] = useState(false)

  useEffect(() => {
    if (projectDirectory) {
      setProjectTargetDirectory(projectDirectory)
    }
  }, [projectDirectory])

  useEffect(() => {
    const options = scope === 'project' && projectTargetDirectory
      ? { directory: projectTargetDirectory }
      : undefined

    window.coworkApi.custom.listMcps(options).then((mcps) => {
      setExistingNames((mcps || []).map((mcp) => mcp.name))
    }).catch(() => setExistingNames([]))
  }, [projectTargetDirectory, scope])

  // Pull custom skills so the user can pre-wire this MCP into any skills
  // that should auto-attach it when added to an agent. The linking itself
  // is written into the skills' SKILL.md frontmatter on save, keeping
  // storage unidirectional (skill → tool) like the built-in pattern.
  useEffect(() => {
    const options = scope === 'project' && projectTargetDirectory
      ? { directory: projectTargetDirectory }
      : undefined

    window.coworkApi.custom.listSkills(options)
      .then((skills) => {
        setAvailableSkills(skills || [])
        // In edit mode, mark every skill that already references this MCP
        // as linked so the checkbox grid reflects the current on-disk
        // wiring. Without this, the picker would look empty even when
        // skills are already linked.
        if (existing?.name) {
          setLinkedSkillNames(
            (skills || [])
              .filter((skill) => (skill.toolIds || []).includes(existing.name))
              .map((skill) => skill.name),
          )
        }
      })
      .catch(() => setAvailableSkills([]))
  }, [existing?.name, projectTargetDirectory, scope])

  useEffect(() => {
    window.coworkApi.app.config()
      .then((config) => setAuthModeAvailable(config?.auth?.mode === 'google-oauth'))
      .catch(() => setAuthModeAvailable(false))
  }, [])

  const draft = useMemo<CustomMcpConfig>(() => {
    const mcp: CustomMcpConfig = {
      scope,
      directory: scope === 'project' ? projectTargetDirectory || null : null,
      name: name.trim(),
      label: label.trim() || undefined,
      description: description.trim() || undefined,
      type,
    }

    if (type === 'stdio') {
      mcp.command = command.trim()
      mcp.args = args.trim() ? args.trim().split(/\s+/).filter(Boolean) : []
      const env: Record<string, string> = {}
      for (const { key, value } of envPairs) {
        if (key.trim()) env[key.trim()] = value
      }
      if (Object.keys(env).length > 0) mcp.env = env
      if (googleAuthEnabled && authModeAvailable) mcp.googleAuth = true
    } else {
      mcp.url = url.trim()
      const headers: Record<string, string> = {}
      for (const { key, value } of headerPairs) {
        if (key.trim()) headers[key.trim()] = value
      }
      if (Object.keys(headers).length > 0) mcp.headers = headers
    }

    return mcp
  }, [args, authModeAvailable, command, description, envPairs, googleAuthEnabled, headerPairs, label, name, projectTargetDirectory, scope, type, url])

  const issues = useMemo(() => {
    const next: string[] = []
    if (!draft.name) {
      next.push('Add an MCP id so the runtime can register it.')
    } else if (!VALID_NAME.test(draft.name)) {
      next.push('Use alphanumeric characters, hyphens, or underscores only for the MCP id.')
    }
    if (draft.name && !isEditing && existingNames.includes(draft.name)) {
      next.push(`A custom MCP named "${draft.name}" already exists.`)
    }
    if (scope === 'project' && !projectTargetDirectory) {
      next.push('Choose a project directory for this project-scoped MCP.')
    }
    if (type === 'stdio' && !draft.command?.trim()) {
      next.push('Add the stdio command that starts this MCP server.')
    }
    if (type === 'http' && !draft.url?.trim()) {
      next.push('Add the HTTP or SSE endpoint URL for this MCP server.')
    }
    return next
  }, [draft.command, draft.name, draft.url, existingNames, isEditing, projectTargetDirectory, scope, type])

  const chooseProjectDirectory = async () => {
    const selected = await window.coworkApi.dialog.selectDirectory()
    if (!selected) return
    setProjectTargetDirectory(selected)
    setScope('project')
  }

  const handleTest = async () => {
    if (issues.length > 0) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.coworkApi.custom.testMcp(draft)
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (issues.length > 0) return
    setSaving(true)
    await window.coworkApi.custom.addMcp(draft)

    // Sync skill frontmatter toolIds so checkboxes are the source of truth
    // for skill ↔ MCP links. Picked skills gain the id, unpicked skills
    // lose it. We re-save the whole bundle because `saveCustomSkill` wipes
    // and recreates the directory — carrying content, files, and existing
    // toolIds preserves the rest of the bundle as the user authored it.
    const mcpId = draft.name
    const desired = new Set(linkedSkillNames)
    for (const skill of availableSkills) {
      const currentToolIds = skill.toolIds || []
      const currentlyLinked = currentToolIds.includes(mcpId)
      const shouldBeLinked = desired.has(skill.name)
      if (currentlyLinked === shouldBeLinked) continue
      const nextToolIds = shouldBeLinked
        ? Array.from(new Set([...currentToolIds, mcpId]))
        : currentToolIds.filter((id) => id !== mcpId)
      await window.coworkApi.custom.addSkill({ ...skill, toolIds: nextToolIds })
    }

    setSaving(false)
    onSave()
  }

  const toggleLinkedSkill = (skillName: string) => {
    setLinkedSkillNames((current) => (
      current.includes(skillName)
        ? current.filter((entry) => entry !== skillName)
        : [...current, skillName]
    ))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1120px] mx-auto px-8 py-8">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Capabilities
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">
              {isEditing ? `Edit MCP tool — ${existing?.name}` : 'Add MCP tool'}
            </h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              {isEditing
                ? `Update the configuration for this MCP. Changes take effect after ${getBrandName()} reloads the runtime.`
                : `Connect a Model Context Protocol server and make its toolset available inside ${getBrandName()} and OpenCode.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || issues.length > 0}
              className="px-4 py-2 rounded-lg text-[13px] font-medium bg-accent cursor-pointer disabled:opacity-40"
              style={{ color: 'var(--color-accent-foreground)' }}
            >
              {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add MCP'}
            </button>
          </div>
        </div>

        {issues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-[12px] font-medium text-text mb-2">Complete these before saving</div>
            <div className="flex flex-col gap-1 text-[11px] text-text-muted">
              {issues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">Where to save it</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setScope('machine')}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'machine' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Cowork only (private)
                </button>
                <button
                  onClick={() => setScope('project')}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Project (Cowork only)
                </button>
              </div>
              <div className="mt-2 text-[11px] text-text-muted">
                {scope === 'project'
                  ? (projectTargetDirectory || 'Choose a project directory to save this into Cowork’s private project config overlay.')
                  : 'Saved into Cowork’s private machine config. This stays separate from your normal CLI OpenCode machine config.'}
              </div>
              {scope === 'project' ? (
                <button
                  onClick={() => void chooseProjectDirectory()}
                  className="mt-3 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
                >
                  {projectTargetDirectory ? 'Change directory' : 'Choose directory'}
                </button>
              ) : null}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">Connection type</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button onClick={() => setType('stdio')} className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${type === 'stdio' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
                  stdio (local process)
                </button>
                <button onClick={() => setType('http')} className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${type === 'http' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
                  HTTP / SSE (remote)
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-muted">MCP id</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. github, jira, slack"
                    disabled={isEditing}
                    className={`${inputClass} ${isEditing ? 'opacity-60 cursor-not-allowed' : ''}`}
                  />
                  <span className="text-[10px] text-text-muted">This becomes the runtime namespace and permission prefix.</span>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-text-muted">Display name</span>
                  <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. GitHub, Jira, Slack" className={inputClass} />
                  <span className="text-[10px] text-text-muted">Optional. If blank, the UI will humanize the MCP id.</span>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-muted">Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="What this MCP gives agents access to."
                  className="w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y"
                />
              </label>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-[14px] font-semibold text-text mb-3">Connection details</div>
              {type === 'stdio' ? (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">Command</span>
                    <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx, node, python" className={inputClass} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">Arguments</span>
                    <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-github" className={inputClass} />
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] text-text-muted">Environment variables</span>
                    {envPairs.map((pair, index) => (
                      <div key={index} className="flex gap-2">
                        <input type="text" value={pair.key} onChange={(e) => { const next = [...envPairs]; next[index].key = e.target.value; setEnvPairs(next) }} placeholder="GITHUB_TOKEN" className={`${inputClass} flex-1`} />
                        <input type="password" value={pair.value} onChange={(e) => { const next = [...envPairs]; next[index].value = e.target.value; setEnvPairs(next) }} placeholder="value" className={`${inputClass} flex-1`} />
                      </div>
                    ))}
                    <button onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])} className="text-[11px] text-accent cursor-pointer text-left">+ Add variable</button>
                  </div>
                  {authModeAvailable ? (
                    <label className="flex items-start gap-3 rounded-lg border border-border-subtle bg-elevated px-3 py-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={googleAuthEnabled}
                        onChange={(event) => setGoogleAuthEnabled(event.target.checked)}
                        className="mt-0.5"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-text">Reuse {getBrandName()} Google sign-in</span>
                        <span className="text-[10px] text-text-muted leading-relaxed">
                          Injects <span className="font-mono">GOOGLE_APPLICATION_CREDENTIALS</span> into this subprocess
                          pointing at your Google ADC file. Useful for trusted Google MCPs (Sheets, BigQuery, Drive) so
                          they skip a second OAuth prompt. Only takes effect once you&apos;re signed in; otherwise the
                          MCP spawns without it.
                        </span>
                      </div>
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">URL</span>
                    <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={inputClass} />
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] text-text-muted">Headers</span>
                    {headerPairs.map((pair, index) => (
                      <div key={index} className="flex gap-2">
                        <input type="text" value={pair.key} onChange={(e) => { const next = [...headerPairs]; next[index].key = e.target.value; setHeaderPairs(next) }} placeholder="Authorization" className={`${inputClass} flex-1`} />
                        <input type="password" value={pair.value} onChange={(e) => { const next = [...headerPairs]; next[index].value = e.target.value; setHeaderPairs(next) }} placeholder="Bearer ..." className={`${inputClass} flex-1`} />
                      </div>
                    ))}
                    <button onClick={() => setHeaderPairs([...headerPairs, { key: '', value: '' }])} className="text-[11px] text-accent cursor-pointer text-left">+ Add header</button>
                    <div className="text-[10px] text-text-muted">
                      Leave headers blank for remote MCPs that use OpenCode&apos;s browser-based OAuth flow.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="mb-3">
                <div className="text-[14px] font-semibold text-text">Linked skills</div>
                <div className="text-[11px] text-text-muted mt-1">
                  Pre-wire this MCP into custom skills that should request it automatically.
                  {getBrandName()} writes this MCP&apos;s id into each selected skill&apos;s
                  SKILL.md frontmatter <span className="font-mono">toolIds</span>.
                </div>
              </div>
              {availableSkills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {availableSkills.map((skill) => {
                    const selected = linkedSkillNames.includes(skill.name)
                    return (
                      <button
                        key={skill.name}
                        type="button"
                        onClick={() => toggleLinkedSkill(skill.name)}
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] border cursor-pointer transition-colors"
                        style={{
                          color: selected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                          background: selected
                            ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                            : 'var(--color-elevated)',
                          borderColor: selected
                            ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)'
                            : 'var(--color-border-subtle)',
                        }}
                      >
                        <PluginIcon icon={skill.name} size={14} />
                        {skill.name}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-text-muted italic">
                  No custom skills discovered yet. Add a skill bundle from the Capabilities page
                  and it will show up here.
                </div>
              )}
            </div>
          </div>

          <div className="xl:sticky xl:top-6 self-start flex flex-col gap-4">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[12px] font-semibold text-text mb-3">MCP preview</div>
              <div className="rounded-xl border border-border-subtle bg-elevated p-4 mb-4">
                <div className="text-[11px] text-text-secondary mb-1">Display name</div>
                <div className="text-[13px] font-medium text-text">{label.trim() || name.trim() || 'New MCP'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">Runtime namespace</div>
                <div className="text-[12px] text-text">{name.trim() || 'not-set'}</div>
                <div className="mt-3 text-[11px] text-text-secondary mb-1">Permission prefix</div>
                <div className="text-[11px] text-text-muted font-mono">{name.trim() ? `mcp__${name.trim()}__*` : 'Set an MCP id to generate this.'}</div>
              </div>

              <div className="flex flex-col gap-3 text-[11px] text-text-muted">
                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="text-text-secondary mb-1">Connection summary</div>
                  <div>{type === 'stdio' ? 'Starts a local MCP server process.' : 'Connects to a remote MCP endpoint.'}</div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-text-secondary">Connectivity test</div>
                    <button
                      onClick={() => void handleTest()}
                      disabled={testing || issues.length > 0}
                      className="px-2.5 py-1 rounded-md text-[10px] border border-border-subtle text-accent disabled:opacity-40 cursor-pointer"
                    >
                      {testing ? 'Testing…' : 'Test MCP'}
                    </button>
                  </div>
                  {testResult ? (
                    testResult.ok ? (
                      <div className="flex flex-col gap-2">
                        <div className="text-[11px]" style={{ color: 'var(--color-green)' }}>
                          Connected successfully. Found {testResult.methods.length} {testResult.methods.length === 1 ? 'method' : 'methods'}.
                        </div>
                        {testResult.methods.slice(0, 6).map((method) => (
                          <div key={method.id} className="text-[10px] text-text-muted">
                            <span className="text-text-secondary">{method.id}</span>
                            {method.description ? ` · ${method.description}` : ''}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px]" style={{ color: 'var(--color-amber)' }}>
                        {testResult.error || 'Could not connect to this MCP.'}
                      </div>
                    )
                  ) : (
                    <div>Run a test before saving to confirm the server responds and exposes methods.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-5 text-[10px] text-text-muted">{getBrandName()} reloads the runtime automatically after saving.</p>
      </div>
    </div>
  )
}
