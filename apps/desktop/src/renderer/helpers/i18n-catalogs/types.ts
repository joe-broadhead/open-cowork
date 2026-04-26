export interface LocaleCatalog {
  locale: string
  nativeLabel: string
  rtl?: boolean
  strings: Record<string, string>
}
