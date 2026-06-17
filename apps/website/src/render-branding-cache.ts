import type { PublicBrandingConfig } from '@open-cowork/shared'

import { hasPublicBrandingThemeOverride, resolvePublicBranding } from './branding.ts'
import { cloudWebsiteStyles } from './styles.ts'

// SSR template cache. The cloud host passes the SAME `publicBranding`/`policy.publicBranding`
// object every request (it lives on `this.options`) and only the per-request CSP nonce varies —
// which sits on the `<style>`/`<script>` *attributes*, never inside the CSS. So the expensive,
// nonce-free, per-branding work (resolve + the ~3k-line CSS concat + theme-override probe) is
// memoised by the stable input reference via a WeakMap (auto-GC'd, no key serialization). The
// default branding (no input object) is rebuilt each time — a rare, cheap path.
export type BrandingRender = { branding: PublicBrandingConfig; css: string; themeLocked: boolean }

const brandingRenderCache = new WeakMap<object, BrandingRender>()

export function resolveBrandingRender(rawBranding: PublicBrandingConfig | null | undefined): BrandingRender {
  if (rawBranding && typeof rawBranding === 'object') {
    const cached = brandingRenderCache.get(rawBranding)
    if (cached) return cached
  }
  const branding = resolvePublicBranding(rawBranding)
  const entry: BrandingRender = {
    branding,
    css: cloudWebsiteStyles(branding),
    themeLocked: hasPublicBrandingThemeOverride(rawBranding),
  }
  if (rawBranding && typeof rawBranding === 'object') brandingRenderCache.set(rawBranding, entry)
  return entry
}
