import type {
  AutomationAutonomyPolicy,
  AutomationExecutionMode,
  EffectiveAppSettings,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

export function AutomationSettingsPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  const toggles = [
    {
      key: 'automationLaunchAtLogin' as const,
      title: t('settings.automations.launchAtLoginTitle', 'Launch at login'),
      description: t('settings.automations.launchAtLoginDescription', 'Start Open Cowork automatically when you sign in so scheduled work can run without a manual app launch.'),
    },
    {
      key: 'automationRunInBackground' as const,
      title: t('settings.automations.runInBackgroundTitle', 'Run in background'),
      description: t('settings.automations.runInBackgroundDescription', 'Hide the window instead of quitting when you close it, so automations and scheduled work can keep running.'),
    },
    {
      key: 'automationDesktopNotifications' as const,
      title: t('settings.automations.notificationsTitle', 'Desktop notifications'),
      description: t('settings.automations.notificationsDescription', 'Show native notifications when an automation needs approval, asks for input, fails, or finishes a run.'),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.automations.header', 'Automation Preferences')}</span>
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

      <span className={sectionLabelCls}>{t('settings.automations.defaultsHeader', 'Defaults')}</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.defaultAutonomy', 'Default autonomy')}</span>
            <select
              value={settings.defaultAutomationAutonomyPolicy}
              onChange={(event) => update({ defaultAutomationAutonomyPolicy: event.target.value as AutomationAutonomyPolicy })}
              className={inputCls}
            >
              <option value="review-first">{t('settings.automations.reviewFirst', 'Review first')}</option>
              <option value="mostly-autonomous">{t('settings.automations.mostlyAutonomous', 'Mostly autonomous')}</option>
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.defaultExecution', 'Default execution mode')}</span>
            <select
              value={settings.defaultAutomationExecutionMode}
              onChange={(event) => update({ defaultAutomationExecutionMode: event.target.value as AutomationExecutionMode })}
              className={inputCls}
            >
              <option value="planning_only">{t('settings.automations.planningOnly', 'Planning only')}</option>
              <option value="scoped_execution">{t('settings.automations.scopedExecution', 'Scoped execution')}</option>
            </select>
          </label>
        </div>
      </div>

      <span className={sectionLabelCls}>{t('settings.automations.quietHoursHeader', 'Quiet hours')}</span>
      <div className={panelCardCls}>
        <div className="text-[11px] text-text-muted">
          {t('settings.automations.quietHoursDescription', 'Desktop notifications are suppressed during this window. In-app inbox items and deliveries are still recorded.')}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.quietHoursStart', 'Start')}</span>
            <input
              type="time"
              value={settings.automationQuietHoursStart || ''}
              onChange={(event) => update({ automationQuietHoursStart: event.target.value || null })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.quietHoursEnd', 'End')}</span>
            <input
              type="time"
              value={settings.automationQuietHoursEnd || ''}
              onChange={(event) => update({ automationQuietHoursEnd: event.target.value || null })}
              className={inputCls}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
