import type { EffectiveAppSettings, PublicAppConfig, RuntimePermissionPolicy } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'
import { SegmentedControl } from '../ui'

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
            <div className="text-[12px] font-semibold text-text">{t('settings.permissions.runtimeConfigSourceTitle', 'OpenCode config source')}</div>
            <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
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
            <div className="text-[12px] font-semibold text-text">{t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}</div>
            <div className="text-[11px] text-text-muted mt-1">{t('settings.permissions.toolingBridgeDescription', 'In app-isolated mode, expose standard Git, SSH, package-manager, cloud, Docker, and Kubernetes config to the managed runtime. OpenCode config, agents, and skills are never bridged by this setting.')}</div>
            <div className="mt-1 text-[10px] text-text-muted">{t('settings.permissions.toolingBridgeSingleSource', 'This is the same bridge setting shown during setup.')}</div>
          </div>
          <button
            type="button"
            role="switch"
            disabled={runtimeConfigSource === 'machine'}
            aria-checked={runtimeConfigSource === 'app' && settings.runtimeToolingBridgeEnabled}
            aria-label={t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}
            onClick={() => update({ runtimeToolingBridgeEnabled: !settings.runtimeToolingBridgeEnabled })}
            className={`settings-switch shrink-0 ${runtimeConfigSource === 'app' && settings.runtimeToolingBridgeEnabled ? 'settings-switch--on' : ''}`}
          >
            <span className="settings-switch__thumb" />
          </button>
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
      title: t('settings.permissions.bashTitle', 'Shell commands'),
      description: t('settings.permissions.bashDescription', 'Choose whether agents can run terminal commands in the active workspace, and whether each command needs approval.'),
    },
    {
      key: 'fileWritePermission' as const,
      legacyKey: 'enableFileWrite' as const,
      maximum: permissions.fileWrite,
      title: t('settings.permissions.fileWriteTitle', 'File editing'),
      description: t('settings.permissions.fileWriteDescription', 'Choose whether agents can create or modify local workspace files, and whether each edit needs approval.'),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.permissions.header', 'Developer Tools')}</span>
      <div className={panelCardCls}>
        {permissionRows.map((row) => {
          const selected = settings[row.key]
          return (
            <div
              key={row.key}
              id={row.key === 'bashPermission' ? 'settings-permissions-shell' : 'settings-permissions-files'}
              className="flex items-start justify-between gap-4 scroll-mt-4"
            >
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-text">{row.title}</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>
              <SegmentedControl
                label={row.title}
                value={selected}
                onChange={(value) => update({
                  [row.key]: value as RuntimePermissionPolicy,
                  [row.legacyKey]: value !== 'deny',
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
      </div>
    </div>
  )
}
