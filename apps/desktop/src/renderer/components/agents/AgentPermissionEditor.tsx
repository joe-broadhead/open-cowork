import { useMemo } from 'react'
import type {
  CustomAgentPermissionAction,
  CustomAgentPermissionKey,
  CustomAgentPermissionOverride,
  CustomAgentPermissionRule,
} from '@open-cowork/shared'

type Props = {
  value?: CustomAgentPermissionOverride[] | null
  onChange: (next: CustomAgentPermissionOverride[]) => void
  readOnly?: boolean
}

type PermissionRowSpec = {
  key: CustomAgentPermissionKey
  label: string
  code: string
  description: string
  patternHint: string
  supportsRules?: boolean
}

type PermissionEditorRow = Omit<CustomAgentPermissionOverride, 'action'> & {
  action?: CustomAgentPermissionAction
}

const ACTIONS: Array<{ value: CustomAgentPermissionAction; label: string; className: string }> = [
  { value: 'allow', label: 'Allow', className: 'text-green' },
  { value: 'ask', label: 'Ask', className: 'text-accent' },
  { value: 'deny', label: 'Deny', className: 'text-red' },
]

const PERMISSION_ROWS: PermissionRowSpec[] = [
  {
    key: 'web',
    label: 'Web access',
    code: 'webfetch + websearch',
    description: 'Open pages and run searches. Codesearch follows this same ceiling.',
    patternHint: 'domain, URL, or query pattern',
    supportsRules: false,
  },
  {
    key: 'edit',
    label: 'Edit files',
    code: 'edit + write + apply_patch',
    description: 'Create or change files in the active project.',
    patternHint: '*.env, secrets/*, docs/**',
  },
  {
    key: 'bash',
    label: 'Run commands',
    code: 'bash',
    description: 'Execute shell commands through OpenCode.',
    patternHint: 'git *, pnpm test, rm *',
  },
  {
    key: 'task',
    label: 'Delegate work',
    code: 'task',
    description: 'Hand focused work to specialist coworkers.',
    patternHint: 'coworker or subagent name',
  },
  {
    key: 'external_directory',
    label: 'External directories',
    code: 'external_directory',
    description: 'Read or write outside the active project boundary.',
    patternHint: '/Users/me/Downloads/*',
  },
  {
    key: 'mcp',
    label: 'MCP tools',
    code: 'mcp__*',
    description: 'Use connected MCP servers and their methods.',
    patternHint: 'mcp__github__pull_request_read',
  },
]

function rowSupportsRules(key: CustomAgentPermissionKey) {
  return PERMISSION_ROWS.find((row) => row.key === key)?.supportsRules !== false
}

export function normalizeAgentPermissionOverrides(
  value?: CustomAgentPermissionOverride[] | null,
): PermissionEditorRow[] {
  const byKey = new Map((value || []).map((entry) => [entry.key, entry]))
  return PERMISSION_ROWS.map((row) => {
    const entry = byKey.get(row.key)
    const rules = row.supportsRules === false ? [] : entry?.rules || []
    return {
      key: row.key,
      action: entry?.action,
      ...(rules.length ? { rules } : {}),
    }
  })
}

function compactOverride(row: CustomAgentPermissionOverride): CustomAgentPermissionOverride {
  return {
    key: row.key,
    action: row.action,
    ...(rowSupportsRules(row.key) && row.rules?.length ? { rules: row.rules } : {}),
  }
}

function upsertExplicitOverride(
  overrides: CustomAgentPermissionOverride[] | null | undefined,
  row: CustomAgentPermissionOverride,
) {
  const next = [
    ...(overrides || []).filter((entry) => entry.key !== row.key),
    compactOverride(row),
  ]
  const order = new Map(PERMISSION_ROWS.map((entry, index) => [entry.key, index]))
  return next.sort((left, right) => (order.get(left.key) ?? 0) - (order.get(right.key) ?? 0))
}

export function AgentPermissionEditor({ value, onChange, readOnly }: Props) {
  const rows = useMemo(() => normalizeAgentPermissionOverrides(value), [value])
  const explicitKeys = useMemo(() => new Set((value || []).map((entry) => entry.key)), [value])

  const replaceRow = (key: CustomAgentPermissionKey, patch: Partial<CustomAgentPermissionOverride>) => {
    const row = rows.find((entry) => entry.key === key)
    if (!row) return
    onChange(upsertExplicitOverride(value, {
      ...row,
      ...patch,
      action: patch.action ?? row.action ?? 'deny',
      rules: patch.rules ?? row.rules,
    }))
  }

  const addRule = (key: CustomAgentPermissionKey) => {
    const row = rows.find((entry) => entry.key === key)
    if (!row) return
    const explicit = explicitKeys.has(key)
    replaceRow(key, {
      action: explicit ? row.action : 'deny',
      rules: [...(row.rules || []), { pattern: '', action: 'ask' }],
    })
  }

  const updateRule = (
    key: CustomAgentPermissionKey,
    index: number,
    patch: Partial<CustomAgentPermissionRule>,
  ) => {
    const row = rows.find((entry) => entry.key === key)
    if (!row) return
    replaceRow(key, {
      rules: (row.rules || []).map((rule, ruleIndex) => (
        ruleIndex === index ? { ...rule, ...patch } : rule
      )),
    })
  }

  const removeRule = (key: CustomAgentPermissionKey, index: number) => {
    const row = rows.find((entry) => entry.key === key)
    if (!row) return
    replaceRow(key, {
      rules: (row.rules || []).filter((_, ruleIndex) => ruleIndex !== index),
    })
  }

  const removeOverride = (key: CustomAgentPermissionKey) => {
    onChange((value || []).filter((entry) => entry.key !== key))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-text">Read files</div>
            <div className="mt-1 text-2xs leading-relaxed text-text-muted">
              OpenCode requires project read access for context loading. This is fixed and cannot be loosened here.
            </div>
          </div>
          <span className="rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-2xs font-semibold text-green">
            allow · read
          </span>
        </div>
      </div>

      {PERMISSION_ROWS.map((spec) => {
        const row = rows.find((entry) => entry.key === spec.key) || { key: spec.key }
        const explicit = explicitKeys.has(spec.key)
        return (
          <div
            key={spec.key}
            role="group"
            aria-label={`${spec.label} permission`}
            className="rounded-xl border border-border-subtle bg-elevated"
          >
            <div className="flex flex-col gap-3 px-3 py-3 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xs font-semibold text-text">{spec.label}</div>
                  <code className="rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 text-2xs text-text-muted">
                    {spec.code}
                  </code>
                  <span className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-2xs font-medium text-text-muted">
                    {explicit ? 'Saved override' : 'Inherit'}
                  </span>
                </div>
                <div className="mt-1 text-2xs leading-relaxed text-text-muted">{spec.description}</div>
                {explicit && !readOnly ? (
                  <button
                    type="button"
                    onClick={() => removeOverride(spec.key)}
                    className="mt-2 text-2xs font-medium text-accent hover:text-text"
                  >
                    Use inherited access
                  </button>
                ) : null}
              </div>
              <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border-subtle bg-surface">
                {ACTIONS.map((action) => {
                  const active = explicit && row.action === action.value
                  return (
                    <button
                      key={action.value}
                      type="button"
                      disabled={readOnly}
                      onClick={() => replaceRow(spec.key, { action: action.value })}
                      className={`px-3 py-1.5 text-2xs font-semibold ${active ? action.className : 'text-text-muted'} disabled:cursor-default`}
                      style={{
                        background: active ? 'var(--color-surface-active)' : 'transparent',
                      }}
                    >
                      {action.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="border-t border-border-subtle px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-2xs font-medium text-text-secondary">
                  Specific rules
                  <span className="ms-2 text-text-muted">{row.rules?.length || 0}</span>
                </div>
                {spec.supportsRules === false ? null : (
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => addRule(spec.key)}
                    className="rounded-lg border border-border-subtle px-2.5 py-1 text-2xs font-medium text-accent hover:bg-surface-hover disabled:cursor-default disabled:opacity-50"
                  >
                    Add rule
                  </button>
                )}
              </div>
              {spec.supportsRules === false ? (
                <div className="text-2xs text-text-muted">
                  OpenCode exposes this group as scalar tool access, so URL and domain-specific web rules are not saved.
                </div>
              ) : row.rules?.length ? (
                <div className="flex flex-col gap-2">
                  {row.rules.map((rule, index) => (
                    <div key={`${spec.key}-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <input
                        value={rule.pattern}
                        disabled={readOnly}
                        onChange={(event) => updateRule(spec.key, index, { pattern: event.target.value })}
                        placeholder={spec.patternHint}
                        className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 font-mono text-2xs text-text outline-none placeholder:text-text-muted focus:border-border"
                      />
                      <select
                        value={rule.action}
                        disabled={readOnly}
                        onChange={(event) => updateRule(spec.key, index, { action: event.target.value as CustomAgentPermissionAction })}
                        className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-2xs font-semibold text-text outline-none focus:border-border"
                        aria-label={`${spec.label} rule action`}
                      >
                        {ACTIONS.map((action) => (
                          <option key={action.value} value={action.value}>{action.value}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => removeRule(spec.key, index)}
                        className="rounded-lg border border-border-subtle px-3 py-2 text-2xs font-medium text-red hover:bg-surface-hover disabled:cursor-default disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-2xs text-text-muted">
                  {explicit
                    ? 'No narrower rules. The saved override above applies.'
                    : 'No saved override. Selected tools and skills decide inherited access at runtime.'}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
