import type { EffectiveAppSettings, PublicAppConfig, RuntimePermissionPolicy } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'
import { SegmentedControl, Switch } from '../ui'

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
    description: 'Use Cowork-managed agents, skills, MCPs, provider auth, and runtime config in the app sandbox.',
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

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.permissions.advancedHeader', 'Runtime config')}</span>
      <div className={panelCardCls}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">{t('settings.permissions.runtimeConfigSourceTitle', 'OpenCode config source')}</div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              {t('settings.permissions.runtimeConfigSourceDescription', 'Choose whether the managed runtime uses Cowork’s isolated in-app OpenCode config or your machine’s native OpenCode install.')}
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
              disabledReason: option.description,
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
      </div>
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
      legacyKey: 'enableBash' as const,
      maximum: permissions.bash,
      code: 'bash',
      id: 'settings-permissions-shell',
      title: t('settings.permissions.bashTitle', 'Shell commands'),
      description: t('settings.permissions.bashDescription', 'Choose whether agents can run terminal commands in the active workspace, and whether each command needs approval.'),
    },
    {
      key: 'fileWritePermission' as const,
      legacyKey: 'enableFileWrite' as const,
      maximum: permissions.fileWrite,
      code: 'edit/write/apply_patch',
      id: 'settings-permissions-files',
      title: t('settings.permissions.fileWriteTitle', 'File editing'),
      description: t('settings.permissions.fileWriteDescription', 'Choose whether agents can create or modify local workspace files, and whether each edit needs approval.'),
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
      description: t('settings.permissions.externalDirectoryDescription', 'Control Cowork-managed skill bundle directories outside the active project. Local path access remains explicit and scoped.'),
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

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.permissions.header', 'Runtime permissions')}</span>
      <div className={panelCardCls}>
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
                  {row.title} <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">{row.code}</code>
                </div>
                <div className="text-xs text-text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>
              <SegmentedControl
                label={row.title}
                value={selected}
                onChange={(value) => update({
                  [row.key]: value as RuntimePermissionPolicy,
                  ...(row.legacyKey ? { [row.legacyKey]: value !== 'deny' } : {}),
                } as Partial<EffectiveAppSettings>)}
                className="settings-permission-control shrink-0"
                options={PERMISSION_OPTIONS.map((option) => {
                  const allowed = canSelectPermission(option.value, row.maximum)
                  return {
                    value: option.value,
                    label: t(`settings.permissions.mode.${option.value}`, option.label),
                    disabled: !allowed,
                    disabledReason: allowed
                      ? option.description
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
              {t('settings.permissions.webSearchTitle', 'Web search')} <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">websearch</code>
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
              {t('settings.permissions.readTitle', 'Read project files')} <code className="rounded border border-border-subtle bg-base px-1 py-0.5 text-xs text-text-muted">read/grep/glob/list</code>
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              {t('settings.permissions.readDescription', 'Read-only project inspection stays allowed so coworkers can understand the workspace before asking to change it.')}
            </div>
          </div>
          <div className="rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-xs font-semibold text-text-muted">
            {t('settings.permissions.fixedAllow', 'Fixed allow')}
          </div>
        </div>
      </div>

      <span className={sectionLabelCls}>{t('settings.permissions.reviewGateHeader', 'Review gates')}</span>
      <div className={panelCardCls}>
        <div id="settings-permissions-review-send" className="flex items-start justify-between gap-4 scroll-mt-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text">{t('settings.permissions.reviewSendTitle', 'Require approval before sending')}</div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">{t('settings.permissions.reviewSendDeferredDescription', 'External-send review will be controlled here when Gateway delivery policy enforcement is wired. Existing provider and tool approval policies remain in force.')}</div>
          </div>
          <div className="rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-xs font-semibold text-text-muted">
            {t('settings.permissions.deferred', 'Deferred')}
          </div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface px-3 py-3 text-xs leading-relaxed text-text-muted">
          {t('settings.permissions.knowledgeReviewDeferred', 'Knowledge review gates will appear here when the Knowledge/Wiki phase is enabled.')}
        </div>
      </div>
    </div>
  )
}
