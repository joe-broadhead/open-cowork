import { useEffect, useMemo, useState } from 'react'
import type { CustomMcpConfig, CustomMcpTestResult, CustomSkillConfig } from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import { TOOL_TRACE_RULES_CHANGED_EVENT } from '../../helpers/tool-trace-events'
import { Button, Dialog } from '../ui'
import { LinkedSkillsCard, McpPreviewCard, ToolApprovalsCard } from './CustomMcpFormCards'
import {
  buildCustomMcpDraft,
  collectCustomMcpIssues,
  createKeyValueDraft,
  createKeyValueDraftsFromRecord,
  customMcpInputClass as inputClass,
  linkedSkillNamesForMcp,
  nextSkillToolIdsForMcp,
  type KeyValueDraft,
  toggleStringSelection,
} from './custom-mcp-form-support'

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
  const [traceLabel, setTraceLabel] = useState(existing?.traceLabel || '')
  const [tracePluralLabel, setTracePluralLabel] = useState(existing?.tracePluralLabel || '')
  const [command, setCommand] = useState(existing?.command || '')
  const [args, setArgs] = useState((existing?.args || []).join(' '))
  const [url, setUrl] = useState(existing?.url || '')
  const [envPairs, setEnvPairs] = useState<KeyValueDraft[]>(() => (
    createKeyValueDraftsFromRecord(existing?.env)
  ))
  const [headerPairs, setHeaderPairs] = useState<KeyValueDraft[]>(() => (
    createKeyValueDraftsFromRecord(existing?.headers)
  ))
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
  // SSRF opt-in: HTTP MCPs default to public-internet only so a
  // prompt-injected agent can't target cloud-metadata endpoints or
  // corporate-internal services. Enabling this unlocks localhost +
  // RFC1918 ranges — required for on-prem company MCPs but must be
  // an explicit user decision.
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(Boolean(existing?.allowPrivateNetwork))
  // Custom MCP tools default to OpenCode approval prompts. Trusted MCPs
  // can opt into allow-mode so agents assigned that MCP can call its
  // methods without prompting every time.
  const [permissionMode, setPermissionMode] = useState<'ask' | 'allow'>(
    existing?.permissionMode === 'allow' ? 'allow' : 'ask',
  )
  // Toggling private-network access on is gated behind a styled confirm
  // dialog; until the user confirms, the checkbox stays unchecked.
  const [privateNetworkConfirmOpen, setPrivateNetworkConfirmOpen] = useState(false)

  const handleAllowPrivateNetworkChange = (checked: boolean) => {
    if (!checked) {
      setAllowPrivateNetwork(false)
      return
    }
    setPrivateNetworkConfirmOpen(true)
  }

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
          setLinkedSkillNames(linkedSkillNamesForMcp(skills || [], existing.name))
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
    return buildCustomMcpDraft({
      scope,
      projectTargetDirectory,
      name,
      label,
      description,
      traceLabel,
      tracePluralLabel,
      type,
      command,
      args,
      url,
      envPairs,
      headerPairs,
      googleAuthEnabled,
      authModeAvailable,
      allowPrivateNetwork,
      permissionMode,
    })
  }, [allowPrivateNetwork, args, authModeAvailable, command, description, envPairs, googleAuthEnabled, headerPairs, label, name, permissionMode, projectTargetDirectory, scope, traceLabel, tracePluralLabel, type, url])

  const issues = useMemo(() => {
    return collectCustomMcpIssues({
      draft,
      isEditing,
      existingNames,
      scope,
      projectTargetDirectory,
      type,
    })
  }, [draft, existingNames, isEditing, projectTargetDirectory, scope, type])

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
      const shouldBeLinked = desired.has(skill.name)
      const nextToolIds = nextSkillToolIdsForMcp({ currentToolIds, mcpId, shouldBeLinked })
      if (!nextToolIds) continue
      await window.coworkApi.custom.addSkill({ ...skill, toolIds: nextToolIds })
    }

    window.dispatchEvent(new Event(TOOL_TRACE_RULES_CHANGED_EVENT))
    setSaving(false)
    onSave()
  }

  const toggleLinkedSkill = (skillName: string) => {
    setLinkedSkillNames((current) => toggleStringSelection(current, skillName))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1120px] mx-auto px-8 py-8">
        <button onClick={onCancel} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          {t('capabilities.title', 'Tools & Skills')}
        </button>

        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-text mb-1">
              {isEditing ? t('mcpForm.titleEdit', 'Edit MCP tool — {{name}}', { name: existing?.name || '' }) : t('mcpForm.titleAdd', 'Add MCP tool')}
            </h1>
            <p className="text-sm text-text-secondary leading-relaxed">
              {isEditing
                ? t('mcpForm.subtitleEdit', 'Update the configuration for this MCP. Changes take effect after {{brand}} reloads the runtime.', { brand: getBrandName() })
                : t('mcpForm.subtitleAdd', 'Connect a Model Context Protocol server and make its toolset available inside {{brand}} and OpenCode.', { brand: getBrandName() })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs text-text-secondary bg-surface-hover cursor-pointer">{t('common.cancel', 'Cancel')}</button>
            <button
              onClick={handleSave}
              disabled={saving || issues.length > 0}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent cursor-pointer disabled:opacity-40"
              style={{ color: 'var(--color-accent-foreground)' }}
            >
              {saving ? t('mcpForm.saving', 'Saving…') : isEditing ? t('mcpForm.saveChanges', 'Save changes') : t('mcpForm.addMcp', 'Add MCP')}
            </button>
          </div>
        </div>

        {issues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border-subtle px-4 py-3">
            <div className="text-xs font-medium text-text mb-2">{t('mcpForm.completeBeforeSave', 'Complete these before saving')}</div>
            <div className="flex flex-col gap-1 text-2xs text-text-muted">
              {issues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-md font-semibold text-text mb-3">{t('mcpForm.whereToSave', 'Where to save it')}</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setScope('machine')}
                  className={`flex-1 px-3 py-2 text-xs font-medium cursor-pointer ${scope === 'machine' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Cowork only (private)
                </button>
                <button
                  onClick={() => setScope('project')}
                  className={`flex-1 px-3 py-2 text-xs font-medium cursor-pointer ${scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'}`}
                >
                  Project (Cowork only)
                </button>
              </div>
              <div className="mt-2 text-2xs text-text-muted">
                {scope === 'project'
                  ? (projectTargetDirectory || 'Choose a project directory to save this into Cowork’s private project config overlay.')
                  : 'Saved into Cowork’s private machine config. This stays separate from your normal CLI OpenCode machine config.'}
              </div>
              {scope === 'project' ? (
                <button
                  onClick={() => void chooseProjectDirectory()}
                  className="mt-3 px-3 py-1.5 rounded-lg text-2xs font-medium border border-border-subtle text-accent hover:bg-surface-hover cursor-pointer"
                >
                  {projectTargetDirectory ? 'Change directory' : 'Choose directory'}
                </button>
              ) : null}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-md font-semibold text-text mb-3">{t('mcpForm.connectionType', 'Connection type')}</div>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                <button onClick={() => setType('stdio')} className={`flex-1 px-3 py-2 text-xs font-medium cursor-pointer ${type === 'stdio' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
                  stdio (local process)
                </button>
                <button onClick={() => setType('http')} className={`flex-1 px-3 py-2 text-xs font-medium cursor-pointer ${type === 'http' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
                  HTTP / SSE (remote)
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-text-muted">{t('mcpForm.mcpId', 'MCP id')}</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. github, jira, slack"
                    disabled={isEditing}
                    className={`${inputClass} ${isEditing ? 'opacity-60 cursor-not-allowed' : ''}`}
                  />
                  <span className="text-2xs text-text-muted">{t('mcpForm.mcpIdHint', 'This becomes the runtime namespace and permission prefix.')}</span>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-text-muted">{t('mcpForm.displayName', 'Display name')}</span>
                  <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('mcpForm.displayNamePlaceholder', 'e.g. GitHub, Jira, Slack')} className={inputClass} />
                  <span className="text-2xs text-text-muted">Optional. If blank, the UI will humanize the MCP id.</span>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-2xs text-text-muted">{t('mcpForm.description', 'Description')}</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder={t('mcpForm.descriptionPlaceholder', 'What this MCP gives agents access to.')}
                  className="w-full px-3 py-2 rounded-lg text-xs bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border resize-y"
                />
              </label>

              <div className="mt-4 grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-text-muted">{t('mcpForm.traceLabel', 'Trace label')}</span>
                  <input
                    type="text"
                    value={traceLabel}
                    onChange={(e) => setTraceLabel(e.target.value)}
                    placeholder={t('mcpForm.traceLabelPlaceholder', 'e.g. ticket action')}
                    className={inputClass}
                  />
                  <span className="text-2xs text-text-muted">
                    Used in chat summaries for this MCP&apos;s tool calls.
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-text-muted">{t('mcpForm.tracePluralLabel', 'Plural trace label')}</span>
                  <input
                    type="text"
                    value={tracePluralLabel}
                    onChange={(e) => setTracePluralLabel(e.target.value)}
                    placeholder={t('mcpForm.tracePluralLabelPlaceholder', 'e.g. ticket actions')}
                    className={inputClass}
                  />
                  <span className="text-2xs text-text-muted">
                    Optional. Defaults to the trace label plus “s”.
                  </span>
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-5">
              <div className="text-md font-semibold text-text mb-3">{t('mcpForm.connectionDetails', 'Connection details')}</div>
              {type === 'stdio' ? (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-text-muted">{t('mcpForm.command', 'Command')}</span>
                    <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('mcpForm.commandPlaceholder', 'e.g. npx, node, python')} className={inputClass} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-text-muted">{t('mcpForm.arguments', 'Arguments')}</span>
                    <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={t('mcpForm.argumentsPlaceholder', 'e.g. -y @modelcontextprotocol/server-github')} className={inputClass} />
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-2xs text-text-muted">{t('mcpForm.envVars', 'Environment variables')}</span>
                    {envPairs.map((pair) => (
                      <div key={pair.id} className="flex gap-2">
                        <input type="text" value={pair.key} onChange={(e) => setEnvPairs((current) => current.map((entry) => entry.id === pair.id ? { ...entry, key: e.target.value } : entry))} placeholder="GITHUB_TOKEN" className={`${inputClass} flex-1`} />
                        <input type="password" value={pair.value} onChange={(e) => setEnvPairs((current) => current.map((entry) => entry.id === pair.id ? { ...entry, value: e.target.value } : entry))} placeholder={t('mcpForm.envValuePlaceholder', 'value')} className={`${inputClass} flex-1`} />
                      </div>
                    ))}
                    <button onClick={() => setEnvPairs((current) => [...current, createKeyValueDraft()])} className="text-2xs text-accent cursor-pointer text-start">+ Add variable</button>
                  </div>
                  {authModeAvailable ? (
                    // Label + checkbox are explicitly paired via htmlFor/id;
                    // the lint rule flags the depth of the text inside
                    // child <span>s but the association is correct.
                    // eslint-disable-next-line jsx-a11y/label-has-associated-control
                    <label htmlFor="mcp-google-auth" className="flex items-start gap-3 rounded-lg border border-border-subtle bg-elevated px-3 py-2.5 cursor-pointer">
                      <input
                        id="mcp-google-auth"
                        type="checkbox"
                        checked={googleAuthEnabled}
                        onChange={(event) => setGoogleAuthEnabled(event.target.checked)}
                        className="mt-0.5"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs text-text">Reuse {getBrandName()} Google sign-in</span>
                        <span className="text-2xs text-text-muted leading-relaxed">
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
                    <span className="text-2xs text-text-muted">{t('mcpForm.url', 'URL')}</span>
                    <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={inputClass} />
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-2xs text-text-muted">{t('mcpForm.headers', 'Headers')}</span>
                    {headerPairs.map((pair) => (
                      <div key={pair.id} className="flex gap-2">
                        <input type="text" value={pair.key} onChange={(e) => setHeaderPairs((current) => current.map((entry) => entry.id === pair.id ? { ...entry, key: e.target.value } : entry))} placeholder="Authorization" className={`${inputClass} flex-1`} />
                        <input type="password" value={pair.value} onChange={(e) => setHeaderPairs((current) => current.map((entry) => entry.id === pair.id ? { ...entry, value: e.target.value } : entry))} placeholder="Bearer ..." className={`${inputClass} flex-1`} />
                      </div>
                    ))}
                    <button onClick={() => setHeaderPairs((current) => [...current, createKeyValueDraft()])} className="text-2xs text-accent cursor-pointer text-start">+ Add header</button>
                    <div className="text-2xs text-text-muted">
                      Leave headers blank for remote MCPs that use OpenCode&apos;s browser-based OAuth flow. After
                      saving, authenticate the MCP from the status panel once the runtime reloads.
                    </div>
                  </div>
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                  <label htmlFor="mcp-allow-private-network" className="flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer"
                    style={{
                      borderColor: allowPrivateNetwork
                        ? 'color-mix(in srgb, var(--color-amber) 40%, var(--color-border-subtle))'
                        : 'var(--color-border-subtle)',
                      background: allowPrivateNetwork
                        ? 'color-mix(in srgb, var(--color-amber) 6%, var(--color-elevated))'
                        : 'var(--color-elevated)',
                    }}
                  >
                    <input
                      id="mcp-allow-private-network"
                      type="checkbox"
                      checked={allowPrivateNetwork}
                      onChange={(event) => handleAllowPrivateNetworkChange(event.target.checked)}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-text">{t('mcpForm.allowPrivateNetwork', 'Allow private network')}</span>
                      <span className="text-2xs text-text-muted leading-relaxed">
                        Unblock <span className="font-mono">localhost</span>, <span className="font-mono">127.*</span>, and
                        RFC1918 ranges (<span className="font-mono">10.*</span>, <span className="font-mono">192.168.*</span>).
                        Only enable this for on-prem or dev MCPs you trust — prompts can otherwise abuse it to reach
                        cloud-metadata endpoints like <span className="font-mono">169.254.169.254</span>.
                      </span>
                    </div>
                  </label>
                </div>
              )}
            </div>

            <ToolApprovalsCard
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
            />

            <LinkedSkillsCard
              availableSkills={availableSkills}
              linkedSkillNames={linkedSkillNames}
              onToggleSkill={toggleLinkedSkill}
            />
          </div>

          <div className="xl:sticky xl:top-6 self-start flex flex-col gap-4">
            <McpPreviewCard
              label={label}
              name={name}
              type={type}
              permissionMode={permissionMode}
              traceLabel={traceLabel}
              tracePluralLabel={tracePluralLabel}
              testResult={testResult}
              testing={testing}
              hasIssues={issues.length > 0}
              onTest={() => void handleTest()}
            />
          </div>
        </div>

        <p className="mt-5 text-2xs text-text-muted">{t('mcpForm.reloadsRuntimeNote', '{{brand}} reloads the runtime automatically after saving.', { brand: getBrandName() })}</p>
      </div>

      {privateNetworkConfirmOpen && (
        <Dialog
          title={t('mcpForm.allowPrivateNetwork', 'Allow private network')}
          size="sm"
          onClose={() => setPrivateNetworkConfirmOpen(false)}
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPrivateNetworkConfirmOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setAllowPrivateNetwork(true)
                  setPrivateNetworkConfirmOpen(false)
                }}
              >
                {t('mcpForm.allowPrivateNetworkConfirmAction', 'Allow')}
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-text-secondary">
            {t(
              'mcpForm.allowPrivateNetworkConfirm',
              'Allow this MCP to reach localhost and private network addresses? Only enable this for endpoints you control or trust.',
            )}
          </p>
        </Dialog>
      )}
    </div>
  )
}
