import { useState } from 'react'
import type { EffectiveAppSettings, PublicAppConfig, RuntimePermissionPolicy } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { sectionLabelCls } from './settings-panel-styles'
import { Badge, Button, Card, SegmentedControl, Switch } from '@open-cowork/ui'

const PERMISSION_RANK: Record<RuntimePermissionPolicy, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

const PERMISSION_OPTIONS: Array<{ value: RuntimePermissionPolicy; label: string; description: string }> = [
  { value: 'deny', label: 'Off', description: 'Block the tool.' },
  { value: 'ask', label: 'Ask', description: 'Prompt before each side effect.' },
  { value: 'allow', label: 'Allow', description: 'Run without repeated prompts.' },
]

const RUNTIME_CONFIG_SOURCE_OPTIONS = [
  {
    value: 'app',
    label: 'App isolated',
    description: 'Use Open Cowork–managed agents, skills, MCPs, provider auth, and runtime config in the app sandbox.',
  },
  {
    value: 'machine',
    label: 'Machine OpenCode',
    description: 'Advanced: use your normal OpenCode config, agents, skills, tools, and provider auth from this machine.',
  },
] as const

function canSelectPermission(value: RuntimePermissionPolicy, maximum: RuntimePermissionPolicy) {
  return PERMISSION_RANK[value] <= PERMISSION_RANK[maximum]
}

function SettingsSwitch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
  )
}

export function RuntimeConfigPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  const runtimeConfigSource = settings.runtimeConfigSource === 'machine' ? 'machine' : 'app'
  // JOE-876: advanced runtime source/bridge stays collapsed unless the user opts in.
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className={sectionLabelCls}>{t('settings.permissions.advancedHeader', 'Advanced runtime')}</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded
            ? t('settings.permissions.hideAdvanced', 'Hide advanced')
            : t('settings.permissions.showAdvanced', 'Show advanced')}
        </Button>
      </div>
      {!expanded ? (
        <Card variant="flat" padding="sm" className="text-xs leading-relaxed text-text-muted">
          {t(
            'settings.permissions.advancedCollapsedHint',
            'OpenCode config source and developer tooling bridge stay hidden by default. Most users should leave the Open Cowork–managed app sandbox as-is.',
          )}
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text">{t('settings.permissions.runtimeConfigSourceTitle', 'OpenCode config source')}</div>
              <div className="text-xs text-text-muted mt-1 leading-relaxed">
                {t('settings.permissions.runtimeConfigSourceDescription', 'Choose whether the managed runtime uses Open Cowork’s isolated in-app OpenCode config or your machine’s native OpenCode install.')}
              </div>
            </div>
            <SegmentedControl
              label={t('settings.permissions.runtimeConfigSourceTitle', 'OpenCode config source')}
              value={runtimeConfigSource}
              onChange={(value) => update({ runtimeConfigSource: value } as Partial<EffectiveAppSettings>)}
              className="settings-runtime-source-control shrink-0"
              options={RUNTIME_CONFIG_SOURCE_OPTIONS.map((option) => ({
                value: option.value,
                label: t(`settings.permissions.runtimeConfigSource.${option.value}`, option.label),
                description: t(`settings.permissions.runtimeConfigSourceHint.${option.value}`, option.description),
              }))}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-text">{t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}</div>
              <div className="text-xs text-text-muted mt-1">{t('settings.permissions.toolingBridgeDescription', 'In app-isolated mode, expose standard Git, SSH, package-manager, cloud, Docker, and Kubernetes config to the managed runtime. OpenCode config, agents, and skills are never bridged by this setting.')}</div>
              <div className="mt-1 text-xs text-text-muted">{t('settings.permissions.toolingBridgeSingleSource', 'This is the same bridge setting shown during setup.')}</div>
            </div>
            <Switch
              checked={runtimeConfigSource === 'app' && settings.runtimeToolingBridgeEnabled}
              onCheckedChange={() => update({ runtimeToolingBridgeEnabled: !settings.runtimeToolingBridgeEnabled })}
              disabled={runtimeConfigSource === 'machine'}
              aria-label={t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}
            />
          </div>
        </Card>
      )}
    </div>
  )
}

export function PermissionsPanel({
  permissions,
  settings,
  update,
}: {
  permissions: PublicAppConfig['permissions']
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  const permissionRows = [
    {
      key: 'bashPermission' as const,
      maximum: permissions.bash,
      code: 'bash',
      id: 'settings-permissions-shell',
      title: t('settings.permissions.bashTitle', 'Shell commands'),
      description: t('settings.permissions.bashDescription', 'Choose whether coworkers can run terminal commands in the active workspace, and whether each command needs approval.'),
    },
    {
      key: 'fileWritePermission' as const,
      maximum: permissions.fileWrite,
      code: 'edit/write/apply_patch',
      id: 'settings-permissions-files',
      title: t('settings.permissions.fileWriteTitle', 'File editing'),
      description: t('settings.permissions.fileWriteDescription', 'Choose whether coworkers can create or modify local workspace files, and whether each edit needs approval.'),
    },
    {
      key: 'webPermission' as const,
      maximum: permissions.web,
      code: 'webfetch/codesearch',
      id: 'settings-permissions-web',
      title: t('settings.permissions.webTitle', 'Open web pages'),
      description: t('settings.permissions.webDescription', 'Choose whether coworkers can fetch pages and use code search through OpenCode web-capable tools.'),
    },
    {
      key: 'taskPermission' as const,
      maximum: permissions.task,
      code: 'task',
      id: 'settings-permissions-task',
      title: t('settings.permissions.taskTitle', 'Delegate to coworkers'),
      description: t('settings.permissions.taskDescription', 'Choose whether primary coworkers may start delegated OpenCode child sessions.'),
    },
    {
      key: 'externalDirectoryPermission' as const,
      maximum: 'allow' as const,
      code: 'external_directory',
      id: 'settings-permissions-external-directory',
      title: t('settings.permissions.externalDirectoryTitle', 'Managed external directories'),
      description: t('settings.permissions.externalDirectoryDescription', 'Control Open Cowork–managed skill bundle directories outside the active project. Local path access remains explicit and scoped.'),
    },
    {
      key: 'mcpPermission' as const,
      maximum: 'allow' as const,
      code: 'mcp__*',
      id: 'settings-permissions-mcp',
      title: t('settings.permissions.mcpTitle', 'MCP tools'),
      description: t('settings.permissions.mcpDescription', 'Set the ceiling for configured MCP tool patterns. Per-coworker and per-MCP policy can still be stricter.'),
    },
  ]

  // JOE-876: tool policy codes and power details stay collapsed by default.
  const [showToolCodes, setShowToolCodes] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <span className={sectionLabelCls}>{t('settings.permissions.header', 'Runtime permissions')}</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setShowToolCodes((value) => !value)}
          aria-expanded={showToolCodes}
        >
          {showToolCodes
            ? t('settings.permissions.hideToolCodes', 'Hide tool ids')
            : t('settings.permissions.showToolCodes', 'Show tool ids')}
        </Button>
      </div>
      <Card className="flex flex-col gap-4">
        {permissionRows.map((row) => {
          const selected = settings[row.key]
          return (
            <div
              key={row.key}
              id={row.id}
              className="flex items-start justify-between gap-4 scroll-mt-4"
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold text-text">
                  {row.title}
                  {showToolCodes ? (
                    <>
                      {' '}
                      <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">{row.code}</code>
                    </>
                  ) : null}
                </div>
                <div className="text-xs text-text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>
              <SegmentedControl
                label={row.title}
                value={selected}
                onChange={(value) => update({
                  [row.key]: value as RuntimePermissionPolicy,
                } as Partial<EffectiveAppSettings>)}
                className="settings-permission-control shrink-0"
                options={PERMISSION_OPTIONS.map((option) => {
                  const allowed = canSelectPermission(option.value, row.maximum)
                  return {
                    value: option.value,
                    label: t(`settings.permissions.mode.${option.value}`, option.label),
                    disabled: !allowed,
                    // Visible on-screen guidance for the selected policy.
                    description: t(`settings.permissions.modeDescription.${option.value}`, option.description),
                    disabledReason: allowed
                      ? undefined
                      : t('settings.permissions.maximumHint', 'This build limits {{tool}} to {{mode}}.', { tool: row.title, mode: row.maximum }),
                  }
                })}
              />
            </div>
          )
        })}
        <div id="settings-permissions-websearch" className="flex items-start justify-between gap-4 scroll-mt-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">
              {t('settings.permissions.webSearchTitle', 'Web search')}
              {showToolCodes ? (
                <>
                  {' '}
                  <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">websearch</code>
                </>
              ) : null}
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              {permissions.webSearch
                ? t('settings.permissions.webSearchDescription', 'Let OpenCode use native web search when web access is not denied.')
                : t('settings.permissions.webSearchDisabledDescription', 'This build disables native web search at the product policy layer.')}
            </div>
          </div>
          <SettingsSwitch
            label={t('settings.permissions.webSearchTitle', 'Web search')}
            checked={permissions.webSearch && settings.webSearchEnabled && settings.webPermission !== 'deny'}
            disabled={!permissions.webSearch || settings.webPermission === 'deny'}
            onChange={() => update({ webSearchEnabled: !settings.webSearchEnabled })}
          />
        </div>
        <div id="settings-permissions-read" className="flex items-start justify-between gap-4 scroll-mt-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">
              {t('settings.permissions.readTitle', 'Read project files')}
              {showToolCodes ? (
                <>
                  {' '}
                  <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">read/grep/glob/list</code>
                </>
              ) : null}
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              {t('settings.permissions.readDescription', 'Read-only project inspection stays allowed so coworkers can understand the workspace before asking to change it.')}
            </div>
          </div>
          <Badge tone="neutral" className="shrink-0">
            {t('settings.permissions.fixedAllow', 'Fixed allow')}
          </Badge>
        </div>
      </Card>

      <span className={sectionLabelCls}>{t('settings.permissions.reviewGateHeader', 'Review gates')}</span>
      <Card className="flex flex-col gap-4">
        <div id="settings-permissions-review-send" className="flex items-start justify-between gap-4 scroll-mt-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">{t('settings.permissions.reviewSendTitle', 'Require approval before sending')}</div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">{t('settings.permissions.reviewSendDeferredDescription', 'External-send review will be controlled here when Gateway delivery policy enforcement is wired. Existing provider and tool approval policies remain in force.')}</div>
          </div>
          <Badge tone="neutral" className="shrink-0">
            {t('settings.permissions.deferred', 'Deferred')}
          </Badge>
        </div>
        <Card variant="flat" padding="sm" className="text-xs leading-relaxed text-text-muted">
          {t('settings.permissions.knowledgeReviewDeferred', 'Knowledge review gates will appear here when the Knowledge/Wiki phase is enabled.')}
        </Card>
      </Card>
    </div>
  )
}
