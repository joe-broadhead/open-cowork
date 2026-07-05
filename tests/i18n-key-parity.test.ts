import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILT_IN_LOCALE_METADATA,
  loadBuiltInCatalog,
} from '../packages/app/src/helpers/i18n-catalogs/registry.ts'

test('built-in translated locale catalogs keep the same key set', async () => {
  const translatedCatalogs = await Promise.all(
    BUILT_IN_LOCALE_METADATA
      .filter(({ locale }) => locale !== 'en')
      .map(async ({ locale }) => {
        const catalog = await loadBuiltInCatalog(locale)
        assert.ok(catalog, `expected built-in catalog for ${locale}`)
        return [locale, Object.keys(catalog.strings).sort()] as const
      }),
  )
  const [reference] = translatedCatalogs
  assert.ok(reference, 'expected at least one translated locale catalog')
  const [, referenceKeys] = reference

  for (const [locale, keys] of translatedCatalogs) {
    const keySet = new Set(keys)
    const referenceSet = new Set(referenceKeys)
    const missing = referenceKeys.filter((key) => !keySet.has(key))
    const extra = keys.filter((key) => !referenceSet.has(key))
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${locale} locale catalog keys drifted from the translated catalog set`,
    )
  }
})
