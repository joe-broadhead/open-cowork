import type { EffectiveAppSettings } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

export function PermissionsPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.permissions.header', 'Developer Tools')}</span>
      <div className={panelCardCls}>
        {[
          {
            key: 'enableBash' as const,
            title: t('settings.permissions.bashTitle', 'Shell commands'),
            description: t('settings.permissions.bashDescription', 'Allow agents to run terminal commands inside the active workspace.'),
          },
          {
            key: 'enableFileWrite' as const,
            title: t('settings.permissions.fileWriteTitle', 'File editing'),
            description: t('settings.permissions.fileWriteDescription', 'Allow agents to create and modify files in the local workspace.'),
          },
          {
            key: 'runtimeToolingBridgeEnabled' as const,
            title: t('settings.permissions.toolingBridgeTitle', 'Developer config bridge'),
            description: t('settings.permissions.toolingBridgeDescription', 'Expose standard Git, SSH, package-manager, cloud, Docker, and Kubernetes config to the managed OpenCode runtime. Disable this for a stricter runtime HOME.'),
          },
        ].map((toggle) => {
          const enabled = settings[toggle.key]
          return (
            <div key={toggle.key} className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-semibold text-text">{toggle.title}</div>
                <div className="text-[11px] text-text-muted mt-1">{toggle.description}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={toggle.title}
                onClick={() => update({ [toggle.key]: !enabled } as Partial<EffectiveAppSettings>)}
                className="w-10 h-5 rounded-full transition-colors relative shrink-0 cursor-pointer"
                style={{ background: enabled ? 'var(--color-accent)' : 'var(--color-border)' }}
              >
                <div
                  className="w-3.5 h-3.5 rounded-full absolute top-[3px] transition-all border border-border-subtle"
                  style={{
                    left: enabled ? 20 : 3,
                    background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
                  }}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
