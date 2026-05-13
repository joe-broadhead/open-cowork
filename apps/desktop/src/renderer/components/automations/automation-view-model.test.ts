import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_UX_V2_FEATURE_GATE_KEY,
  buildAutomationSchedulePreview,
  buildDraftSchedulePreview,
  createDefaultDraft,
  formatSchedule,
  isAutomationUxV2Enabled,
} from './automation-view-model'

describe('automation-view-model', () => {
  it('keeps automation UX v2 default-off behind an explicit feature gate', () => {
    window.localStorage.removeItem(AUTOMATION_UX_V2_FEATURE_GATE_KEY)

    try {
      expect(isAutomationUxV2Enabled()).toBe(false)

      window.localStorage.setItem(AUTOMATION_UX_V2_FEATURE_GATE_KEY, 'true')

      expect(isAutomationUxV2Enabled()).toBe(true)
    } finally {
      window.localStorage.removeItem(AUTOMATION_UX_V2_FEATURE_GATE_KEY)
    }
  })

  it('formats schedules in operator-facing language', () => {
    expect(formatSchedule({
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    })).toBe('Every Monday at 09:00')
    expect(formatSchedule({
      type: 'monthly',
      timezone: 'UTC',
      dayOfMonth: 31,
      runAtHour: 16,
      runAtMinute: 30,
    })).toBe('Every month on day 31 at 16:30')
  })

  it('summarizes saved automation schedules, check-ins, and quiet-hour impact', () => {
    const preview = buildAutomationSchedulePreview({
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 23,
        runAtMinute: 0,
      },
      nextRunAt: '2026-05-14T23:00:00.000Z',
      nextHeartbeatAt: '2026-05-14T12:00:00.000Z',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    })

    expect(preview.cadence).toBe('Every day at 23:00')
    expect(preview.nextRun).toContain('Next run')
    expect(preview.checkIn).toContain('Next check-in')
    expect(preview.quietHours).toContain('inside notification quiet hours')
  })

  it('previews draft schedules before creation', () => {
    const preview = buildDraftSchedulePreview({
      draft: createDefaultDraft(),
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    })

    expect(preview.cadence).toBe('Every Monday at 09:00')
    expect(preview.nextRun).toContain('First run')
    expect(preview.checkIn).toBe('15 minute check-ins after creation.')
    expect(preview.quietHours).toContain('do not overlap')
  })
})
