import type { EffectiveAppSettings, PublicAppConfig, RuntimePermissionPolicy } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

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

function canSelectPermission(value: RuntimePermissionPolicy, maximum: RuntimePermissionPolicy) {
  return PERMISSION_RANK[value] <= PERMISSION_RANK[maximum]
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
            <div key={row.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-text">{row.title}</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>
              <div role="group" aria-label={row.title} className="shrink-0 grid grid-cols-3 rounded-xl border border-border-subtle overflow-hidden">
                {PERMISSION_OPTIONS.map((option) => {
                  const allowed = canSelectPermission(option.value, row.maximum)
                  const active = selected === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!allowed}
                      title={allowed ? option.description : t('settings.permissions.maximumHint', 'This build limits {{tool}} to {{mode}}.', { tool: row.title, mode: row.maximum })}
                      aria-pressed={active}
                      onClick={() => update({
                        [row.key]: option.value,
                        [row.legacyKey]: option.value !== 'deny',
                      } as Partial<EffectiveAppSettings>)}
                      className="px-3 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                      style={{
                        background: active ? 'var(--color-accent)' : 'transparent',
                        color: active ? 'var(--color-accent-foreground)' : 'var(--color-text-muted)',
                      }}
                    >
                      {t(`settings.permissions.mode.${option.value}`, option.label)}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[12px] font-semibold text-text">{t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}</div>
            <div className="text-[11px] text-text-muted mt-1">{t('settings.permissions.toolingBridgeDescription', 'Expose standard Git, SSH, package-manager, cloud, Docker, and Kubernetes config to the managed OpenCode runtime. Disable this for a stricter runtime HOME.')}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.runtimeToolingBridgeEnabled}
            aria-label={t('settings.permissions.toolingBridgeTitle', 'Developer config bridge')}
            onClick={() => update({ runtimeToolingBridgeEnabled: !settings.runtimeToolingBridgeEnabled })}
            className="w-10 h-5 rounded-full transition-colors relative shrink-0 cursor-pointer"
            style={{ background: settings.runtimeToolingBridgeEnabled ? 'var(--color-accent)' : 'var(--color-border)' }}
          >
            <div
              className="w-3.5 h-3.5 rounded-full absolute top-[3px] transition-all border border-border-subtle"
              style={{
                left: settings.runtimeToolingBridgeEnabled ? 20 : 3,
                background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
              }}
            />
          </button>
        </div>
      </div>
    </div>
  )
}
