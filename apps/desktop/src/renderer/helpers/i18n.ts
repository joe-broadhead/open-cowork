import type { AppI18nConfig } from '@open-cowork/shared'
import {
  BUILT_IN_LOCALE_METADATA,
  getBuiltInLocaleMetadata,
  loadBuiltInCatalog,
} from './i18n-catalogs/registry.ts'
import type { LocaleCatalog } from './i18n-catalogs/types.ts'

// Renderer-side i18n runtime. Three layers compose the active catalog:
//
//   1. Built-in catalogs (`i18n-catalogs/`) ship with the upstream
//      app. Zero-config: a user whose OS locale matches a built-in
//      sees the translated UI on first launch.
//   2. Downstream overrides via `config.i18n.strings` merge on top of
//      the built-in catalog, so a fork can retune a specific phrase
//      for their brand without re-translating the whole app.
//   3. User preference (Settings → Language) wins over everything
//      and persists to localStorage so the choice survives reload.
//
// Keys are dot-separated and scoped by screen/widget. Every call to
// `t()` passes an English fallback so a missing key never renders
// empty; the fallback is the source of truth for the English
// baseline.

const LANGUAGE_STORAGE_KEY = 'open-cowork.locale.v1'
const LEGACY_LANGUAGE_STORAGE_KEY = 'opencowork.locale.v1'

let cachedCatalog: Record<string, string> = {}
let cachedLocale: string | undefined
let cachedCatalogRecord: LocaleCatalog | undefined
let configuredLocale: string | undefined
let downstreamStrings: Record<string, string> = {}
let catalogLoadVersion = 0

// Ordered list of locales to try when resolving a catalog. Resolves
// "fr-CA" → "fr-CA" → "fr" pattern so `fr-*` variants inherit the
// base French catalog automatically.
function candidateLocales(locale: string): string[] {
  const out: string[] = []
  let current = locale
  while (current) {
    out.push(current)
    const dash = current.lastIndexOf('-')
    if (dash < 0) break
    current = current.slice(0, dash)
  }
  return out
}

function lookupBuiltInMetadata(locale: string | undefined) {
  if (!locale) return undefined
  for (const candidate of candidateLocales(locale)) {
    const match = getBuiltInLocaleMetadata(candidate)
    if (match) return match
  }
  return undefined
}

async function lookupBuiltInCatalog(locale: string | undefined): Promise<LocaleCatalog | undefined> {
  if (!locale) return undefined
  for (const candidate of candidateLocales(locale)) {
    const match = await loadBuiltInCatalog(candidate)
    if (match) return match
  }
  return undefined
}

function detectPreferredLocale(): string | undefined {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
      || window.localStorage.getItem(LEGACY_LANGUAGE_STORAGE_KEY)
    if (stored && stored.trim()) return stored
  } catch {
    /* localStorage unavailable — fall through */
  }
  return undefined
}

function systemLocale(): string | undefined {
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
  return undefined
}

// Apply document-level locale hints so assistive tech, CSS
// (`:lang()`), and RTL layout behave correctly. Runs whenever the
// active catalog changes. No-ops outside a browser (tests).
function applyDocumentLocale() {
  if (typeof document === 'undefined') return
  const lang = cachedLocale || 'en'
  const metadata = lookupBuiltInMetadata(cachedLocale)
  const dir = (cachedCatalogRecord?.rtl || metadata?.rtl) ? 'rtl' : 'ltr'
  document.documentElement.lang = lang
  document.documentElement.dir = dir
}

function applyCatalog(catalog: LocaleCatalog | undefined) {
  cachedCatalogRecord = catalog
  const builtInStrings = catalog?.strings || {}
  // Downstream overrides merge on top so a fork can retune a specific
  // key without re-translating the full catalog.
  cachedCatalog = { ...builtInStrings, ...downstreamStrings }
  applyDocumentLocale()
}

async function rebuildCatalog() {
  const version = ++catalogLoadVersion
  const locale = cachedLocale
  applyCatalog(undefined)
  let catalog: LocaleCatalog | undefined
  try {
    catalog = await lookupBuiltInCatalog(locale)
  } catch {
    catalog = undefined
  }
  if (version !== catalogLoadVersion) return
  applyCatalog(catalog)
  notifyLocaleSubscribers()
}

// Seed the catalog + locale at app boot from the public app config.
// Called once in App.tsx alongside brand / theme setup. Resolution
// order: user preference (localStorage) → config.i18n.locale →
// system locale → undefined (host default formatting, English text).
export async function configureI18n(config?: AppI18nConfig) {
  const preferred = detectPreferredLocale()
  configuredLocale = config?.locale?.trim() || undefined
  cachedLocale = preferred || configuredLocale || systemLocale() || undefined
  downstreamStrings = config?.strings ? { ...config.strings } : {}
  await rebuildCatalog()
}

// User-initiated locale change from the Settings Language picker.
// Persists to localStorage so the choice survives reload, then
// rebuilds the catalog from the matching built-in + downstream
// overrides. Pass null to clear the user preference and fall back
// to config + system detection.
export async function setLocale(locale: string | null) {
  try {
    if (locale) {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale)
      window.localStorage.removeItem(LEGACY_LANGUAGE_STORAGE_KEY)
    } else {
      window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_LANGUAGE_STORAGE_KEY)
    }
  } catch {
    /* non-fatal */
  }
  cachedLocale = locale || configuredLocale || systemLocale() || undefined
  // Clear memoized Intl formatters so subsequent formatNumber/Date
  // calls reflect the new locale immediately.
  numberFormatters.clear()
  compactFormatters.clear()
  dateFormatters.clear()
  await rebuildCatalog()
}

export function getLocale(): string | undefined {
  return cachedLocale
}

// Lightweight pub/sub so React can live-re-render on locale change
// without the app having to page-reload (which would close modals,
// reset scroll positions, and close the Settings panel before the user
// has a chance to hit Save).
const localeSubscribers = new Set<() => void>()
function notifyLocaleSubscribers() {
  for (const fn of localeSubscribers) {
    try { fn() } catch { /* subscriber failure must not block others */ }
  }
}
export function subscribeLocale(callback: () => void): () => void {
  localeSubscribers.add(callback)
  return () => { localeSubscribers.delete(callback) }
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

// Auto-derived from the built-in catalog registry so adding a
// language in `i18n-catalogs/index.ts` is a one-line change that
// flows straight through to the Settings picker with no manual
// duplication.
export function getBuiltInLocales(): Array<{ locale: string; nativeLabel: string; rtl: boolean }> {
  return BUILT_IN_LOCALE_METADATA
    .map((catalog) => ({
      locale: catalog.locale,
      nativeLabel: catalog.nativeLabel,
      rtl: catalog.rtl === true,
    }))
    .sort((a, b) => a.nativeLabel.localeCompare(b.nativeLabel))
}
