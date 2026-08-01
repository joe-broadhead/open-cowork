import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '../../helpers/i18n'
import * as i18n from '../../helpers/i18n'
import { LanguagePicker } from './SettingsLanguagePicker'

const featureValueTelemetry = vi.hoisted(() => ({
  recordFeatureValueDiscovery: vi.fn(),
  recordFeatureValueActivation: vi.fn(),
}))

vi.mock('../../helpers/feature-value-telemetry', () => featureValueTelemetry)

beforeEach(async () => {
  await i18n.configureI18n(undefined)
  await setLocale(null)
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.configureI18n(undefined)
  await setLocale(null)
})

describe('LanguagePicker value telemetry', () => {
  it('shows a configured region locale as its matching built-in language', async () => {
    await i18n.configureI18n({ locale: 'de-DE' })

    render(<LanguagePicker />)

    expect(screen.getByRole('button', { name: /Deutsch — experimental, \d+% translated/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Auto-detect/ })).not.toBeInTheDocument()
  })

  it('does not count retained English as experimental-locale activation', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.click(screen.getByRole('button', { name: /^Language:/ }))
    await user.click(screen.getByRole('option', { name: 'English' }))

    await waitFor(() => expect(window.localStorage.getItem('open-cowork.locale.v1')).toBe('en'))
    expect(featureValueTelemetry.recordFeatureValueActivation).not.toHaveBeenCalledWith('locales')
  })

  it('counts discovery and an explicit experimental locale opt-in, but not reset to automatic', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    expect(featureValueTelemetry.recordFeatureValueDiscovery).toHaveBeenCalledWith('locales')

    await user.click(screen.getByRole('button', { name: /^Language:/ }))
    await user.click(screen.getByRole('option', { name: /Deutsch/ }))
    await waitFor(() => {
      expect(window.localStorage.getItem('open-cowork.locale.v1')).toBe('de')
      expect(featureValueTelemetry.recordFeatureValueActivation).toHaveBeenCalledWith('locales')
    })
    expect(screen.getByRole('button', { name: /Deutsch — experimental, \d+% translated/ })).toBeInTheDocument()
    expect(screen.getByText(
      'English is supported. Non-English languages are explicit experiments and fall back to English for untranslated copy; automatic detection uses supported languages only.',
    )).toBeInTheDocument()

    featureValueTelemetry.recordFeatureValueActivation.mockClear()
    await user.click(screen.getByRole('button', { name: /^(Language|Sprache):/ }))
    expect(screen.getByRole('option', { name: 'Auto-detect (supported languages)' })).toBeInTheDocument()
    await user.click(screen.getAllByRole('option')[0]!)

    await waitFor(() => expect(window.localStorage.getItem('open-cowork.locale.v1')).toBeNull())
    expect(featureValueTelemetry.recordFeatureValueActivation).not.toHaveBeenCalledWith('locales')
  })

  it('keeps the latest selected locale when an older catalog load finishes late', async () => {
    let resolveGerman!: (applied: boolean) => void
    const german = new Promise<boolean>((resolve) => { resolveGerman = resolve })
    let activeLocale = 'en'
    vi.spyOn(i18n, 'getLocale').mockImplementation(() => activeLocale)
    vi.spyOn(i18n, 'setLocale').mockImplementation(async (locale) => {
      if (locale === 'de') return german
      activeLocale = locale || 'en'
      return true
    })
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.click(screen.getByRole('button', { name: /^Language:/ }))
    await user.click(screen.getByRole('option', { name: /Deutsch/ }))
    await user.click(screen.getByRole('button', { name: /^Language:/ }))
    await user.click(screen.getByRole('option', { name: /Français/ }))
    expect(await screen.findByRole('button', { name: /Language: Français/ })).toBeInTheDocument()

    resolveGerman(false)
    await german
    expect(screen.getByRole('button', { name: /Language: Français/ })).toBeInTheDocument()
  })
})
