import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The i18n module reaches for `window.localStorage` and
// `document.documentElement`. Provide tiny stand-ins so we can
// exercise the runtime under Node without pulling in jsdom.
const storage = new Map<string, string>()
const documentEl = { lang: '', dir: '' as 'ltr' | 'rtl' | '' }

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  },
  configurable: true,
  writable: true,
})
Object.defineProperty(globalThis, 'document', {
  value: { get documentElement() { return documentEl } },
  configurable: true,
  writable: true,
})
// Node provides a read-only `navigator` — override via defineProperty.
let navLanguage = 'en-US'
Object.defineProperty(globalThis, 'navigator', {
  value: { get language() { return navLanguage } },
  configurable: true,
  writable: true,
})

// Import after globals are stubbed — the runtime reads them at first use.
const { setLocale, getLocale, t, configureI18n, getBuiltInLocales, formatNumber } = await import(
  '../apps/desktop/src/renderer/helpers/i18n.ts'
)

describe('i18n runtime', () => {
  beforeEach(() => {
    storage.clear()
    documentEl.lang = ''
    documentEl.dir = ''
    configureI18n(undefined)
  })

  it('registers 12 built-in locales and includes RTL flag for Arabic', () => {
    const locales = getBuiltInLocales()
    const codes = locales.map((l) => l.locale).sort()
    assert.deepEqual(codes, ['ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'ru', 'zh'])
    assert.equal(locales.find((l) => l.locale === 'ar')?.rtl, true)
    assert.equal(locales.find((l) => l.locale === 'fr')?.rtl, false)
  })

  it('resolves `fr-CA` to the base French catalog via candidate fallback', () => {
    setLocale('fr-CA')
    // Key only exists in the French catalog, not English
    const saved = t('common.save', 'Save')
    assert.equal(saved, 'Enregistrer')
  })

  it('applies document.lang and document.dir on locale change', () => {
    setLocale('ar')
    assert.equal(documentEl.lang, 'ar')
    assert.equal(documentEl.dir, 'rtl')

    setLocale('fr')
    assert.equal(documentEl.lang, 'fr')
    assert.equal(documentEl.dir, 'ltr')
  })

  it('persists user locale selection in localStorage', () => {
    setLocale('de')
    assert.equal(storage.get('open-cowork.locale.v1'), 'de')
    assert.equal(storage.has('opencowork.locale.v1'), false)

    setLocale(null)
    assert.equal(storage.has('open-cowork.locale.v1'), false)
  })

  it('falls back to English inline default when a catalog key is missing', () => {
    setLocale('fr')
    const madeUp = t('nonexistent.key', 'English fallback')
    assert.equal(madeUp, 'English fallback')
  })

  it('interpolates {{vars}} after looking up the catalog entry', () => {
    setLocale('fr')
    const rendered = t('sidebar.threadFallback', 'Thread {{id}}', { id: 'abc123' })
    assert.equal(rendered, 'Conversation abc123')
  })

  it('Intl.NumberFormat respects the active locale', () => {
    setLocale('fr')
    // French thousands separator is a non-breaking space (or narrow nbsp)
    const french = formatNumber(1234567)
    assert.ok(/1[\s\u00a0\u202f]234[\s\u00a0\u202f]567/.test(french), `expected French grouping, got: ${JSON.stringify(french)}`)

    setLocale('de')
    const german = formatNumber(1234567)
    assert.equal(german, '1.234.567')

    setLocale('en')
    const english = formatNumber(1234567)
    assert.equal(english, '1,234,567')
  })

  it('reads user preference from localStorage at configure time, overriding system locale', () => {
    storage.set('open-cowork.locale.v1', 'pt')
    storage.set('opencowork.locale.v1', 'ja')
    navLanguage = 'en-US'
    configureI18n(undefined)
    assert.equal(getLocale(), 'pt')
  })

  it('reads legacy user preference from localStorage during migration', () => {
    storage.set('opencowork.locale.v1', 'ja')
    navLanguage = 'en-US'
    configureI18n(undefined)
    assert.equal(getLocale(), 'ja')
    // And the catalog actually loaded — `common.save` is translated
    assert.equal(t('common.save', 'Save'), '保存')
  })

  it('merges downstream config.i18n.strings on top of the built-in catalog', () => {
    configureI18n({ locale: 'fr', strings: { 'common.save': 'Sauver' } })
    assert.equal(t('common.save', 'Save'), 'Sauver')
    // But un-overridden keys still come from the French base catalog
    assert.equal(t('common.cancel', 'Cancel'), 'Annuler')
  })

  it('all 12 locales have matching key sets', async () => {
    const { BUILT_IN_CATALOGS } = await import('../apps/desktop/src/renderer/helpers/i18n-catalogs/index.ts')
    // English is the source of truth via inline fallbacks, so its catalog
    // is intentionally empty. Every other locale should have the same key set.
    const nonEnglishKeys = Object.entries(BUILT_IN_CATALOGS)
      .filter(([code]) => code !== 'en')
      .map(([code, catalog]) => ({ code, keys: Object.keys(catalog.strings).sort() }))

    const reference = nonEnglishKeys[0]
    for (const entry of nonEnglishKeys.slice(1)) {
      assert.deepEqual(
        entry.keys,
        reference.keys,
        `Locale '${entry.code}' has different keys from '${reference.code}'`,
      )
    }
  })
})
