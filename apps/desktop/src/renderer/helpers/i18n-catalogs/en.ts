import type { LocaleCatalog } from './types'

// English is the source-of-truth language: every `t(key, fallback)`
// call ships with an English fallback baked in. This catalog therefore
// carries an empty strings table — every lookup falls through to the
// caller's inline English default. Registered so the Settings picker
// can surface an explicit "English" choice (the system-detect option
// only works if the host OS locale is English).
export const en: LocaleCatalog = {
  locale: 'en',
  nativeLabel: 'English',
  strings: {},
}
