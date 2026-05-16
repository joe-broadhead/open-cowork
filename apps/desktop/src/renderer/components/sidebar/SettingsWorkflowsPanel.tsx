import type { EffectiveAppSettings } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

export function WorkflowSettingsPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  const toggles = [
    {
      key: 'workflowLaunchAtLogin' as const,
      title: t('settings.workflows.launchAtLoginTitle', 'Launch at login'),
      description: t('settings.workflows.launchAtLoginDescription', 'Start Open Cowork automatically when you sign in so scheduled work can run without a manual app launch.'),
    },
    {
      key: 'workflowRunInBackground' as const,
      title: t('settings.workflows.runInBackgroundTitle', 'Run in background'),
      description: t('settings.workflows.runInBackgroundDescription', 'Hide the window instead of quitting when you close it, so workflows and scheduled work can keep running.'),
    },
    {
      key: 'workflowDesktopNotifications' as const,
      title: t('settings.workflows.notificationsTitle', 'Desktop notifications'),
      description: t('settings.workflows.notificationsDescription', 'Show native notifications when a scheduled or webhook workflow needs attention, fails, or finishes a run.'),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.workflows.header', 'Workflow Preferences')}</span>
      <div className={panelCardCls}>
        {toggles.map((toggle) => {
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

      <span className={sectionLabelCls}>{t('settings.workflows.quietHoursHeader', 'Quiet hours')}</span>
      <div className={panelCardCls}>
        <div className="text-[11px] text-text-muted">
          {t('settings.workflows.quietHoursDescription', 'Desktop notifications are suppressed during this window. Scheduled and webhook runs can still start.')}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.workflows.quietHoursStart', 'Start')}</span>
            <input
              type="time"
              value={settings.workflowQuietHoursStart || ''}
              onChange={(event) => update({ workflowQuietHoursStart: event.target.value || null })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.workflows.quietHoursEnd', 'End')}</span>
            <input
              type="time"
              value={settings.workflowQuietHoursEnd || ''}
              onChange={(event) => update({ workflowQuietHoursEnd: event.target.value || null })}
              className={inputCls}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
