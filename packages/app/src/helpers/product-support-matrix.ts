import { BUILT_IN_TRANSLATION_COVERAGE } from './i18n-catalogs/coverage-status.ts'

export const SUPPORTED_LOCALE_COVERAGE_THRESHOLD = 0.95

const NON_ENGLISH_LOCALES = [
  'ar',
  'de',
  'es',
  'fr',
  'hi',
  'it',
  'ja',
  'ko',
  'pt',
  'ru',
  'zh',
] as const

const RETIRED_USER_THEMES = [
  'studio',
  'tokyostorm',
  'frappe',
  'rosepine',
  'nord',
  'everforest',
  'gruvbox',
  'synthwave',
  'dracula',
  'ayu',
  'kanagawa',
  'horizon',
  'oxocarbon',
  'poimandres',
  'cyberdream',
  'matrix',
  'moonfly',
] as const

const RETIRED_USER_ACCENTS = ['azure', 'indigo', 'plum', 'teal', 'amber', 'rose'] as const

/**
 * Maintained product selector matrix. Retired appearance ids stay in the
 * compatibility registry for downstream configs, but public stored choices
 * migrate to the retained default and the normal picker does not advertise
 * them. Experimental locales remain explicitly labelled and opt-in.
 */
export const PRODUCT_SUPPORT_MATRIX = Object.freeze({
  locales: {
    retained: ['en'] as const,
    experimental: NON_ENGLISH_LOCALES,
    removed: [] as const,
    supportedCoverageThreshold: SUPPORTED_LOCALE_COVERAGE_THRESHOLD,
    translatedCoverage: BUILT_IN_TRANSLATION_COVERAGE.translatedKeys
      / BUILT_IN_TRANSLATION_COVERAGE.totalStaticKeys,
    usageEvidence: 'No historical locale-selection baseline is available; incomplete locales remain explicit opt-ins while selection telemetry is collected.',
    owner: 'Localization maintainers',
    qaCost: 'Primary-journey no-fallback suite per locale, plus bidirectional layout coverage where the locale requires it.',
    exitCriteria: 'A locale reaches 95% of core static keys and passes the primary-journey no-fallback suite.',
  },
  appearance: {
    themes: {
      retained: ['mercury'] as const,
      experimental: [] as const,
      removedFromPicker: RETIRED_USER_THEMES,
    },
    accents: {
      retained: ['theme'] as const,
      experimental: [] as const,
      removedFromPicker: RETIRED_USER_ACCENTS,
    },
    densities: {
      retained: ['compact', 'regular', 'comfy'] as const,
      experimental: [] as const,
      removed: [] as const,
    },
    usageEvidence: 'No historical appearance-selection baseline is available; the retained matrix minimizes visual permutations while preference telemetry is collected.',
    owner: 'Design system maintainers',
    qaCost: 'Mercury in dark/light/system modes, with representative compact, regular, and comfy visual coverage.',
  },
})

export function isSupportedAutomaticLocale(locale: string | undefined): boolean {
  if (!locale) return true
  const base = locale.toLowerCase().split('-')[0]
  return base === 'en'
}

export function localeSupportStatus(locale: string): 'retained' | 'experimental' | 'removed' {
  const base = locale.toLowerCase().split('-')[0]
  if (PRODUCT_SUPPORT_MATRIX.locales.retained.includes(base as 'en')) return 'retained'
  if (PRODUCT_SUPPORT_MATRIX.locales.experimental.includes(base as typeof NON_ENGLISH_LOCALES[number])) {
    return 'experimental'
  }
  return 'removed'
}
