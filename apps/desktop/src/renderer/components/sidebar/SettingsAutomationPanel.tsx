import type {
  AutomationAutonomyPolicy,
  AutomationExecutionMode,
  AutonomyLevel,
  EffectiveAppSettings,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
  sectionLabelCls,
} from './settings-panel-styles'

function policyMapToText(map: Record<string, boolean>) {
  return Object.entries(map)
    .filter(([, disabled]) => disabled)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b))
    .join('\n')
}

function textToPolicyMap(value: string) {
  const next: Record<string, boolean> = {}
  for (const rawLine of value.split(/\r?\n/g)) {
    const key = rawLine.trim()
    if (key) next[key] = true
  }
  return next
}

const textareaCls = `${inputCls} min-h-[76px] resize-y leading-relaxed`

function updateIntegerSetting(
  value: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function formatNullableCost(value: number | null) {
  return value === null ? '' : String(value)
}

function updateNullableCost(value: string, fallback: number | null) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.round(parsed * 100) / 100)
}

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

      <span className={sectionLabelCls}>{t('settings.automations.operationsHeader', 'Operations Guardrails')}</span>
      <div className={panelCardCls}>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.automations.operationsDescription', 'These caps apply when automations, SOPs, and crews enter the operations queue. They never grant permissions beyond OpenCode policy or project grants.')}
        </div>
        <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.maxAutonomy', 'Maximum autonomy')}</span>
            <select
              value={settings.operationalMaxAutonomy}
              onChange={(event) => update({ operationalMaxAutonomy: event.target.value as AutonomyLevel })}
              className={inputCls}
            >
              <option value="observe">{t('settings.automations.autonomyObserve', 'Observe')}</option>
              <option value="draft">{t('settings.automations.autonomyDraft', 'Draft')}</option>
              <option value="approve">{t('settings.automations.autonomyApprove', 'Approve')}</option>
              <option value="supervised">{t('settings.automations.autonomySupervised', 'Supervised')}</option>
              <option value="bounded-auto">{t('settings.automations.autonomyBoundedAuto', 'Bounded auto')}</option>
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.writeParallelism', 'Write parallelism')}</span>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.operationalWriteMaxParallel}
              onChange={(event) => update({
                operationalWriteMaxParallel: updateIntegerSetting(
                  event.target.value,
                  settings.operationalWriteMaxParallel,
                  1,
                  10,
                ),
              })}
              className={inputCls}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.maxDuration', 'Max run minutes')}</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.operationalMaxRunDurationMinutes}
              onChange={(event) => update({
                operationalMaxRunDurationMinutes: updateIntegerSetting(
                  event.target.value,
                  settings.operationalMaxRunDurationMinutes,
                  1,
                  1440,
                ),
              })}
              className={inputCls}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.maxCost', 'Queue budget USD')}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={formatNullableCost(settings.operationalMaxCostUsd)}
              placeholder={t('settings.automations.noBudgetCap', 'No cap')}
              onChange={(event) => update({
                operationalMaxCostUsd: updateNullableCost(event.target.value, settings.operationalMaxCostUsd),
              })}
              className={inputCls}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.maxRetries', 'Max retries')}</span>
            <input
              type="number"
              min={0}
              max={10}
              value={settings.operationalMaxRetries}
              onChange={(event) => update({
                operationalMaxRetries: updateIntegerSetting(
                  event.target.value,
                  settings.operationalMaxRetries,
                  0,
                  10,
                ),
              })}
              className={inputCls}
            />
          </label>
        </div>
      </div>

      <span className={sectionLabelCls}>{t('settings.automations.learningHeader', 'Governed learning')}</span>
      <div className={panelCardCls}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[12px] font-semibold text-text">{t('settings.automations.improvementProposalsTitle', 'Improvement proposals')}</div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.automations.improvementProposalsDescription', 'Allow reviewed memories, dream runs, and eval evidence to create proposed improvements. Approved proposals still require explicit review before they affect runtime behavior.')}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.improvementProposalsEnabled}
            aria-label={t('settings.automations.improvementProposalsTitle', 'Improvement proposals')}
            onClick={() => update({ improvementProposalsEnabled: !settings.improvementProposalsEnabled })}
            className="w-10 h-5 rounded-full transition-colors relative shrink-0 cursor-pointer"
            style={{ background: settings.improvementProposalsEnabled ? 'var(--color-accent)' : 'var(--color-border)' }}
          >
            <div
              className="w-3.5 h-3.5 rounded-full absolute top-[3px] transition-all border border-border-subtle"
              style={{
                left: settings.improvementProposalsEnabled ? 20 : 3,
                background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
              }}
            />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4 rounded-md border border-border-subtle p-3 max-[720px]:grid-cols-1">
          <div>
            <div className="text-[12px] font-semibold text-text">{t('settings.automations.dreamScheduleTitle', 'Scheduled consolidation')}</div>
            <div className="mt-1 text-[11px] text-text-muted">
              {t('settings.automations.dreamScheduleDescription', 'Let Open Cowork periodically ask OpenCode to propose memory cleanups. Outputs still land in the Improvement Inbox for review.')}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.dreamConsolidationScheduleEnabled}
            aria-label={t('settings.automations.dreamScheduleTitle', 'Scheduled consolidation')}
            onClick={() => update({ dreamConsolidationScheduleEnabled: !settings.dreamConsolidationScheduleEnabled })}
            className="relative h-5 w-10 shrink-0 cursor-pointer rounded-full transition-colors"
            style={{ background: settings.dreamConsolidationScheduleEnabled ? 'var(--color-accent)' : 'var(--color-border)' }}
          >
            <div
              className="absolute top-[3px] h-3.5 w-3.5 rounded-full border border-border-subtle transition-all"
              style={{
                left: settings.dreamConsolidationScheduleEnabled ? 20 : 3,
                background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
              }}
            />
          </button>
          <label className="col-span-2 flex max-w-[220px] flex-col gap-2 max-[720px]:col-span-1">
            <span className={fieldLabelCls}>{t('settings.automations.dreamIntervalHours', 'Interval (hours)')}</span>
            <input
              type="number"
              min={24}
              max={720}
              value={settings.dreamConsolidationIntervalHours}
              onChange={(event) => update({
                dreamConsolidationIntervalHours: updateIntegerSetting(
                  event.target.value,
                  settings.dreamConsolidationIntervalHours,
                  24,
                  720,
                ),
              })}
              className={inputCls}
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-4 max-[980px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.disabledLearningAgents', 'Disabled agents')}</span>
            <textarea
              value={policyMapToText(settings.improvementProposalsDisabledAgents)}
              onChange={(event) => update({ improvementProposalsDisabledAgents: textToPolicyMap(event.target.value) })}
              className={textareaCls}
              placeholder={t('settings.automations.disabledLearningAgentsPlaceholder', 'build\nresearcher')}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.disabledLearningProjects', 'Disabled projects')}</span>
            <textarea
              value={policyMapToText(settings.improvementProposalsDisabledProjects)}
              onChange={(event) => update({ improvementProposalsDisabledProjects: textToPolicyMap(event.target.value) })}
              className={textareaCls}
              placeholder={t('settings.automations.disabledLearningProjectsPlaceholder', '/workspace/acme')}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.disabledLearningCrews', 'Disabled crews')}</span>
            <textarea
              value={policyMapToText(settings.improvementProposalsDisabledCrews)}
              onChange={(event) => update({ improvementProposalsDisabledCrews: textToPolicyMap(event.target.value) })}
              className={textareaCls}
              placeholder={t('settings.automations.disabledLearningCrewsPlaceholder', 'growth-review')}
            />
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
