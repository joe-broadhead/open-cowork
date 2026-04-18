import type { LocaleCatalog } from './types'
import { ar } from './ar'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { hi } from './hi'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { pt } from './pt'
import { ru } from './ru'
import { zh } from './zh'

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

export type { LocaleCatalog } from './types'
