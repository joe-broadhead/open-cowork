import type { LocaleCatalog } from './types.ts'

export const BUILT_IN_LOCALE_METADATA: Array<Pick<LocaleCatalog, 'locale' | 'nativeLabel' | 'rtl'>> = [
  { locale: 'ar', nativeLabel: 'العربية', rtl: true },
  { locale: 'de', nativeLabel: 'Deutsch', rtl: false },
  { locale: 'en', nativeLabel: 'English', rtl: false },
  { locale: 'es', nativeLabel: 'Español', rtl: false },
  { locale: 'fr', nativeLabel: 'Français', rtl: false },
  { locale: 'hi', nativeLabel: 'हिन्दी', rtl: false },
  { locale: 'it', nativeLabel: 'Italiano', rtl: false },
  { locale: 'ja', nativeLabel: '日本語', rtl: false },
  { locale: 'ko', nativeLabel: '한국어', rtl: false },
  { locale: 'pt', nativeLabel: 'Português', rtl: false },
  { locale: 'ru', nativeLabel: 'Русский', rtl: false },
  { locale: 'zh', nativeLabel: '中文', rtl: false },
]

export function getBuiltInLocaleMetadata(locale: string | undefined) {
  if (!locale) return undefined
  return BUILT_IN_LOCALE_METADATA.find((entry) => entry.locale === locale)
}

export async function loadBuiltInCatalog(locale: string): Promise<LocaleCatalog | undefined> {
  switch (locale) {
    case 'ar': return (await import('./ar.ts')).ar
    case 'de': return (await import('./de.ts')).de
    case 'en': return (await import('./en.ts')).en
    case 'es': return (await import('./es.ts')).es
    case 'fr': return (await import('./fr.ts')).fr
    case 'hi': return (await import('./hi.ts')).hi
    case 'it': return (await import('./it.ts')).it
    case 'ja': return (await import('./ja.ts')).ja
    case 'ko': return (await import('./ko.ts')).ko
    case 'pt': return (await import('./pt.ts')).pt
    case 'ru': return (await import('./ru.ts')).ru
    case 'zh': return (await import('./zh.ts')).zh
    default: return undefined
  }
}
