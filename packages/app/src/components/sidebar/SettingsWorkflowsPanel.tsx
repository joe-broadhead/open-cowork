import type { EffectiveAppSettings } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { Card, Input, Switch } from '../ui'
import {
  fieldLabelCls,
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
      description: t('settings.workflows.runInBackgroundDescription', 'Hide the window instead of quitting when you close it, so playbooks and scheduled work can keep running.'),
    },
    {
      key: 'workflowDesktopNotifications' as const,
      title: t('settings.workflows.notificationsTitle', 'Desktop notifications'),
      description: t('settings.workflows.notificationsDescription', 'Show native notifications when a scheduled or webhook playbook needs attention, fails, or finishes a run.'),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.workflows.header', 'Playbook Preferences')}</span>
      <Card className="flex flex-col gap-4">
        {toggles.map((toggle) => {
          const enabled = settings[toggle.key]
          return (
            <div key={toggle.key} className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-text">{toggle.title}</div>
                <div className="text-2xs text-text-muted mt-1">{toggle.description}</div>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={() => update({ [toggle.key]: !enabled } as Partial<EffectiveAppSettings>)}
                aria-label={toggle.title}
              />
            </div>
          )
        })}
      </Card>

      <span className={sectionLabelCls}>{t('settings.workflows.quietHoursHeader', 'Quiet hours')}</span>
      <Card className="flex flex-col gap-4">
        <div className="text-2xs text-text-muted">
          {t('settings.workflows.quietHoursDescription', 'Desktop notifications are suppressed during this window. Scheduled and webhook runs can still start.')}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.workflows.quietHoursStart', 'Start')}</span>
            <Input
              size="sm"
              type="time"
              aria-label={t('settings.workflows.quietHoursStart', 'Start')}
              value={settings.workflowQuietHoursStart || ''}
              onChange={(event) => update({ workflowQuietHoursStart: event.target.value || null })}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.workflows.quietHoursEnd', 'End')}</span>
            <Input
              size="sm"
              type="time"
              aria-label={t('settings.workflows.quietHoursEnd', 'End')}
              value={settings.workflowQuietHoursEnd || ''}
              onChange={(event) => update({ workflowQuietHoursEnd: event.target.value || null })}
            />
          </div>
        </div>
      </Card>
    </div>
  )
}
