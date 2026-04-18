import type { AppI18nConfig } from '@open-cowork/shared'

// Renderer-side i18n scaffolding. Deliberately minimal — one catalog
// resolver + a thin wrapper around Intl.NumberFormat / DateTimeFormat
// so downstream forks targeting a non-English market can localize
// without introducing a new dependency. Full string coverage is a
// gradual migration; see docs/roadmap.md for the deferred-work plan.
//
// Catalog shape:
//   i18n.strings = {
//     "dashboard.threads": "Gespräche",
//     "dashboard.cost": "Kosten",
//     ...
//   }
//
// Keys are dot-separated and scoped by screen/widget so downstream
// translators can work one surface at a time.

let cachedCatalog: Record<string, string> = {}
let cachedLocale: string | undefined

// Seed the catalog + locale at app boot from the public app config.
// Called once in App.tsx alongside brand / theme setup.
export function configureI18n(config?: AppI18nConfig) {
  cachedCatalog = config?.strings ? { ...config.strings } : {}
  cachedLocale = config?.locale?.trim() || undefined
}

export function getLocale(): string | undefined {
  return cachedLocale
}

// Look up a translation by catalog key. Fallback is the inline English
// default callers pass alongside the key; the fallback is always
// required so a missing catalog entry never renders as empty UI.
//
// Variable interpolation uses {{name}} syntax. Example:
//   t('dashboard.sessions.count', '{{n}} sessions', { n: 42 })
export function t(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const raw = cachedCatalog[key] ?? fallback
  if (!vars) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    const value = vars[name]
    return value === undefined ? `{{${name}}}` : String(value)
  })
}

// Cached Intl formatters keyed by locale so we don't recreate them on
// every render. Formatters are among the most expensive built-ins to
// instantiate, and the chat / dashboard render paths are hot.
const numberFormatters = new Map<string, Intl.NumberFormat>()
const compactFormatters = new Map<string, Intl.NumberFormat>()
const dateFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatNumber(value: number): string {
  const locale = cachedLocale
  const key = locale || '_default_'
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    numberFormatters.set(key, formatter)
  }
  return formatter.format(value)
}

export function formatCompactNumber(value: number): string {
  const locale = cachedLocale
  const key = locale || '_default_'
  let formatter = compactFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    compactFormatters.set(key, formatter)
  }
  return formatter.format(value)
}

export function formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  const locale = cachedLocale
  const key = `${locale || '_default_'}:${JSON.stringify(options || {})}`
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    dateFormatters.set(key, formatter)
  }
  const date = value instanceof Date ? value : new Date(value)
  return formatter.format(date)
}

// Currency formatter. Downstream forks can pass currency via options;
// default is USD to match the upstream pricing catalog.
export function formatCurrency(value: number, currency: string = 'USD'): string {
  const locale = cachedLocale
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
}
