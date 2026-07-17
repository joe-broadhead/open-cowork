import type { CustomMcpTestResult, CustomSkillConfig } from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import { SegmentedControl } from '@open-cowork/ui'
import { PluginIcon } from './PluginIcon'
import type { CustomMcpFormType, CustomMcpPermissionMode } from './custom-mcp-form-support'

export function ToolApprovalsCard({
  permissionMode,
  onPermissionModeChange,
}: {
  permissionMode: CustomMcpPermissionMode
  onPermissionModeChange: (mode: CustomMcpPermissionMode) => void
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-5">
      <div className="mb-3">
        <div className="text-md font-semibold text-text">{t('mcpForm.toolApprovals', 'Tool approvals')}</div>
        <div className="text-2xs text-text-muted mt-1">
          Choose how assigned coworkers should handle this MCP&apos;s tool calls.
        </div>
      </div>
      <SegmentedControl
        label={t('mcpForm.toolApprovals', 'Tool approvals')}
        value={permissionMode}
        onChange={(value) => onPermissionModeChange(value as CustomMcpPermissionMode)}
        options={[
          {
            value: 'ask',
            label: t('mcpForm.approvalAsk', 'Ask before tool calls'),
            description: 'OpenCode asks for approval before an assigned coworker uses this MCP.',
          },
          {
            value: 'allow',
            label: t('mcpForm.approvalAllow', 'Trusted, auto-approve'),
            description: 'Assigned coworkers can call this MCP without approval prompts. Use only for MCPs you control or trust.',
          },
        ]}
      />
    </div>
  )
}

export function LinkedSkillsCard({
  availableSkills,
  linkedSkillNames,
  onToggleSkill,
}: {
  availableSkills: readonly CustomSkillConfig[]
  linkedSkillNames: readonly string[]
  onToggleSkill: (skillName: string) => void
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-5">
      <div className="mb-3">
        <div className="text-md font-semibold text-text">{t('mcpForm.linkedSkills', 'Linked skills')}</div>
        <div className="text-2xs text-text-muted mt-1">
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
                onClick={() => onToggleSkill(skill.name)}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-2xs border cursor-pointer transition-colors"
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
        <div className="text-2xs text-text-muted italic">
          No custom skills discovered yet. Add a skill bundle from the Tools & Skills page
          and it will show up here.
        </div>
      )}
    </div>
  )
}

export function McpPreviewCard({
  label,
  name,
  type,
  permissionMode,
  traceLabel,
  tracePluralLabel,
  testResult,
  testing,
  hasIssues,
  onTest,
}: {
  label: string
  name: string
  type: CustomMcpFormType
  permissionMode: CustomMcpPermissionMode
  traceLabel?: string
  tracePluralLabel?: string
  testResult: CustomMcpTestResult | null
  testing: boolean
  hasIssues: boolean
  onTest: () => void
}) {
  const displayName = label.trim() || name.trim() || 'New MCP'
  const namespace = name.trim() || 'not-set'
  const permissionPrefix = name.trim() ? `mcp__${name.trim()}__*` : 'Set an MCP id to generate this.'
  const effectiveTraceLabel = traceLabel?.trim() || `${displayName} tool`
  const effectiveTracePluralLabel = tracePluralLabel?.trim() || `${effectiveTraceLabel}s`
  const traceSummary = `1 ${effectiveTraceLabel}, 2 ${effectiveTracePluralLabel}`

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="text-xs font-semibold text-text mb-3">{t('mcpForm.preview', 'MCP preview')}</div>
      <div className="rounded-xl border border-border-subtle bg-elevated p-4 mb-4">
        <div className="text-2xs text-text-secondary mb-1">{t('mcpForm.displayName', 'Display name')}</div>
        <div className="text-sm font-medium text-text">{displayName}</div>
        <div className="mt-3 text-2xs text-text-secondary mb-1">{t('mcpForm.runtimeNamespace', 'Runtime namespace')}</div>
        <div className="text-xs text-text">{namespace}</div>
        <div className="mt-3 text-2xs text-text-secondary mb-1">{t('mcpForm.permissionPrefix', 'Permission prefix')}</div>
        <div className="text-2xs text-text-muted font-mono">{permissionPrefix}</div>
        <div className="mt-3 text-2xs text-text-secondary mb-1">{t('mcpForm.tracePreview', 'Trace preview')}</div>
        <div className="text-2xs text-text-muted">{traceSummary}</div>
      </div>

      <div className="flex flex-col gap-3 text-2xs text-text-muted">
        <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
          <div className="text-text-secondary mb-1">{t('mcpForm.connectionSummary', 'Connection summary')}</div>
          <div>{type === 'stdio' ? 'Starts a local MCP server process.' : 'Connects to a remote MCP endpoint.'}</div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
          <div className="text-text-secondary mb-1">{t('mcpForm.approvalSummary', 'Approval summary')}</div>
          <div>
            {permissionMode === 'allow'
              ? 'Trusted MCP. Assigned agents can use its tools automatically.'
              : 'OpenCode will ask before assigned agents use its tools.'}
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-elevated px-3.5 py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-text-secondary">{t('mcpForm.connectivityTest', 'Connectivity test')}</div>
            <button
              onClick={onTest}
              disabled={testing || hasIssues}
              className="px-2.5 py-1 rounded-md text-2xs border border-border-subtle text-accent disabled:opacity-40 cursor-pointer"
            >
              {testing ? 'Testing…' : 'Test MCP'}
            </button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <div className="flex flex-col gap-2">
                <div className="text-2xs" style={{ color: 'var(--color-green)' }}>
                  Connected successfully. Found {testResult.methods.length} {testResult.methods.length === 1 ? 'method' : 'methods'}.
                </div>
                {testResult.methods.slice(0, 6).map((method) => (
                  <div key={method.id} className="text-2xs text-text-muted">
                    <span className="text-text-secondary">{method.id}</span>
                    {method.description ? ` · ${method.description}` : ''}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-2xs" style={{ color: 'var(--color-amber)' }}>
                {testResult.error || t('mcpForm.couldNotConnect', 'Could not connect to this MCP.')}
              </div>
            )
          ) : (
            <div>{t('mcpForm.runTestHint', 'Run a test before saving to confirm the server responds and exposes methods.')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
