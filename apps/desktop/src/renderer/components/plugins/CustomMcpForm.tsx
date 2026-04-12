import { useState } from 'react'
import type { CustomMcpConfig } from '@open-cowork/shared'

export function CustomMcpForm({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }])
  const [headerPairs, setHeaderPairs] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }])
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name) return
    setSaving(true)
    const mcp: CustomMcpConfig = { name, type }
    if (type === 'stdio') {
      mcp.command = command
      mcp.args = args ? args.split(' ').filter(Boolean) : []
      const env: Record<string, string> = {}
      for (const { key, value } of envPairs) {
        if (key) env[key] = value
      }
      if (Object.keys(env).length) mcp.env = env
    } else {
      mcp.url = url
      const headers: Record<string, string> = {}
      for (const { key, value } of headerPairs) {
        if (key) headers[key] = value
      }
      if (Object.keys(headers).length) mcp.headers = headers
    }
    await window.openCowork.custom.addMcp(mcp)
    setSaving(false)
    onSave()
  }

  const inputClass = 'w-full px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border'

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[14px] font-semibold text-text">Add MCP Server</h3>

      {/* Type toggle */}
      <div className="flex rounded-lg border border-border-subtle overflow-hidden">
        <button onClick={() => setType('stdio')} className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${type === 'stdio' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
          stdio (local)
        </button>
        <button onClick={() => setType('http')} className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer ${type === 'http' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>
          HTTP / SSE (remote)
        </button>
      </div>

      {/* Name */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-muted">Name</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. github, jira, slack" className={inputClass} />
      </label>

      {type === 'stdio' ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Command</span>
            <input type="text" value={command} onChange={e => setCommand(e.target.value)} placeholder="e.g. npx, node, python" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Arguments (space-separated)</span>
            <input type="text" value={args} onChange={e => setArgs(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-github" className={inputClass} />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Environment Variables</span>
            {envPairs.map((pair, i) => (
              <div key={i} className="flex gap-2">
                <input type="text" value={pair.key} onChange={e => { const n = [...envPairs]; n[i].key = e.target.value; setEnvPairs(n) }} placeholder="GITHUB_TOKEN" className={inputClass + ' flex-1'} />
                <input type="password" value={pair.value} onChange={e => { const n = [...envPairs]; n[i].value = e.target.value; setEnvPairs(n) }} placeholder="value" className={inputClass + ' flex-1'} />
              </div>
            ))}
            <button onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])} className="text-[11px] text-accent cursor-pointer text-left">+ Add variable</button>
          </div>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">URL</span>
            <input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={inputClass} />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Headers</span>
            {headerPairs.map((pair, i) => (
              <div key={i} className="flex gap-2">
                <input type="text" value={pair.key} onChange={e => { const n = [...headerPairs]; n[i].key = e.target.value; setHeaderPairs(n) }} placeholder="Authorization" className={inputClass + ' flex-1'} />
                <input type="password" value={pair.value} onChange={e => { const n = [...headerPairs]; n[i].value = e.target.value; setHeaderPairs(n) }} placeholder="Bearer ..." className={inputClass + ' flex-1'} />
              </div>
            ))}
            <button onClick={() => setHeaderPairs([...headerPairs, { key: '', value: '' }])} className="text-[11px] text-accent cursor-pointer text-left">+ Add header</button>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer">Cancel</button>
        <button onClick={handleSave} disabled={!name || saving || (type === 'stdio' ? !command : !url)} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-accent cursor-pointer disabled:opacity-40">
          {saving ? 'Saving...' : 'Add MCP'}
        </button>
      </div>

      <p className="text-[10px] text-text-muted">Open Cowork will reload the runtime automatically after saving.</p>
    </div>
  )
}
