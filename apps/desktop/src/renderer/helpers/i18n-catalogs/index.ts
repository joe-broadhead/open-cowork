import type { LocaleCatalog } from './types.ts'
import { ar } from './ar.ts'
import { de } from './de.ts'
import { en } from './en.ts'
import { es } from './es.ts'
import { fr } from './fr.ts'
import { hi } from './hi.ts'
import { it } from './it.ts'
import { ja } from './ja.ts'
import { ko } from './ko.ts'
import { pt } from './pt.ts'
import { ru } from './ru.ts'
import { zh } from './zh.ts'
export { BUILT_IN_LOCALE_METADATA, getBuiltInLocaleMetadata, loadBuiltInCatalog } from './registry.ts'

// Registry of built-in locale catalogs keyed by BASE language code.
// The renderer's i18n runtime resolves `fr-CA` → `fr` via
// candidate-locale fallback (see `i18n.ts`), so we only register
// base-language entries here. Country-specific tweaks ride through
// `config.i18n.strings` overrides instead.
//
// To add a language: create `./<code>.ts`, export a `LocaleCatalog`,
// add the import + entry below. `getBuiltInLocales()` auto-picks
// it up from this registry — no separate metadata table to keep
// in sync.
export const BUILT_IN_CATALOGS: Record<string, LocaleCatalog> = {
  ar,
  de,
  en,
  es,
  fr,
  hi,
  it,
  ja,
  ko,
  pt,
  ru,
  zh,
}

export type { LocaleCatalog } from './types.ts'
