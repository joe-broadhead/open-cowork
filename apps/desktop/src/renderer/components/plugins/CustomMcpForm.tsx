import { useEffect, useMemo, useState } from 'react'
import type { CustomMcpConfig, CustomMcpTestResult } from '@open-cowork/shared'

const inputClass = 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function CustomMcpForm({
  onSave,
  onCancel,
  projectDirectory,
}: {
  onSave: () => void
  onCancel: () => void
  projectDirectory?: string | null
}) {
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [scope, setScope] = useState<'machine' | 'project'>(projectDirectory ? 'project' : 'machine')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }])
  const [headerPairs, setHeaderPairs] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [testResult, setTestResult] = useState<CustomMcpTestResult | null>(null)

  useEffect(() => {
    window.openCowork.custom.listMcps(projectDirectory ? { directory: projectDirectory } : undefined).then((mcps) => {
      setExistingNames((mcps || []).map((mcp) => mcp.name))
    }).catch(() => setExistingNames([]))
  }, [projectDirectory])

  const draft = useMemo<CustomMcpConfig>(() => {
    const mcp: CustomMcpConfig = {
      scope,
      directory: scope === 'project' ? projectDirectory || null : null,
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
    } else {
      mcp.url = url.trim()
      const headers: Record<string, string> = {}
      for (const { key, value } of headerPairs) {
        if (key.trim()) headers[key.trim()] = value
      }
      if (Object.keys(headers).length > 0) mcp.headers = headers
    }

    return mcp
  }, [args, command, description, envPairs, headerPairs, label, name, projectDirectory, scope, type, url])

  const issues = useMemo(() => {
    const next: string[] = []
    if (!draft.name) {
      next.push('Add an MCP id so the runtime can register it.')
    } else if (!VALID_NAME.test(draft.name)) {
      next.push('Use alphanumeric characters, hyphens, or underscores only for the MCP id.')
    }
    if (draft.name && existingNames.includes(draft.name)) {
      next.push(`A custom MCP named "${draft.name}" already exists.`)
    }
    if (scope === 'project' && !projectDirectory) {
      next.push('Project scope requires an active project thread.')
    }
    if (type === 'stdio' && !draft.command?.trim()) {
      next.push('Add the stdio command that starts this MCP server.')
    }
    if (type === 'http' && !draft.url?.trim()) {
      next.push('Add the HTTP or SSE endpoint URL for this MCP server.')
    }
    return next
  }, [draft.command, draft.name, draft.url, existingNames, projectDirectory, scope, type])

  const handleTest = async () => {
    if (issues.length > 0) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.openCowork.custom.testMcp(draft)
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (issues.length > 0) return
    setSaving(true)
    await window.openCowork.custom.addMcp(draft)
    setSaving(false)
    onSave()
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
            <h1 className="text-[18px] font-semibold text-text mb-1">Add MCP tool</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Connect a Model Context Protocol server and make its toolset available inside Open Cowork and OpenCode.
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
              {saving ? 'Saving…' : 'Add MCP'}
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
                  This machine
                </button>
                <button
                  onClick={() => setScope('project')}
                  disabled={!projectDirectory}
                  className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${scope === 'project' ? 'bg-surface-active text-text' : 'text-text-muted'} disabled:opacity-40`}
                >
                  This project
                </button>
              </div>
              <div className="mt-2 text-[11px] text-text-muted">
                {scope === 'project'
                  ? (projectDirectory || 'Open a project thread first to save a project-scoped MCP.')
                  : 'Saved into your machine-scoped OpenCode config for Open Cowork.'}
              </div>
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
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. github, jira, slack" className={inputClass} />
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
                  </div>
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

        <p className="mt-5 text-[10px] text-text-muted">Open Cowork reloads the runtime automatically after saving.</p>
      </div>
    </div>
  )
}
