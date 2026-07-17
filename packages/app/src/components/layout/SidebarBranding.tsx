import { type CSSProperties } from 'react'
import type { BrandingSidebarLowerConfig, BrandingSidebarTopConfig } from '@open-cowork/shared'
import { Card } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'

function safeLogoUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > 1024) return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === 'open-cowork-asset:' && url.hostname === 'branding' ? trimmed : undefined
  } catch {
    return undefined
  }
}

function logoSource(top: BrandingSidebarTopConfig) {
  return safeLogoUrl(top.logoUrl)
}

function safeExternalHref(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? trimmed : null
  } catch {
    return null
  }
}

function sidebarTopVariant(top: BrandingSidebarTopConfig) {
  if (top.variant) return top.variant
  if (logoSource(top)) return top.title || top.subtitle ? 'logo-text' : 'logo'
  if (top.icon) return top.title || top.subtitle ? 'icon-text' : 'icon'
  return 'text'
}

function renderableSidebarTopVariant(
  preferred: NonNullable<BrandingSidebarTopConfig['variant']>,
  options: {
    hasLogo: boolean
    hasIcon: boolean
    hasText: boolean
  },
) {
  const { hasLogo, hasIcon, hasText } = options
  const firstRenderable = (...candidates: Array<NonNullable<BrandingSidebarTopConfig['variant']>>) =>
    candidates.find((candidate) => {
      if (candidate === 'logo') return hasLogo
      if (candidate === 'icon') return hasIcon
      if (candidate === 'text') return hasText
      if (candidate === 'logo-text') return hasLogo && hasText
      return hasIcon && hasText
    }) || null

  switch (preferred) {
    case 'logo':
      return firstRenderable('logo', 'icon', 'text')
    case 'icon':
      return firstRenderable('icon', 'logo', 'text')
    case 'text':
      return firstRenderable('text', 'logo', 'icon')
    case 'logo-text':
      return firstRenderable('logo-text', 'logo', 'text', 'icon')
    case 'icon-text':
      return firstRenderable('icon-text', 'icon', 'text', 'logo')
    default:
      return null
  }
}

const BRAND_MEDIA_SIZE_DEFAULT = 28
const BRAND_MEDIA_SIZE_MIN = 16
const BRAND_MEDIA_SIZE_MAX = 96
const BRAND_MEDIA_FIT_DEFAULT: NonNullable<BrandingSidebarTopConfig['mediaFit']> = 'bounded'

function sidebarBrandMediaSize(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BRAND_MEDIA_SIZE_DEFAULT
  return Math.min(BRAND_MEDIA_SIZE_MAX, Math.max(BRAND_MEDIA_SIZE_MIN, Math.round(value)))
}

function sidebarBrandMediaFit(value: BrandingSidebarTopConfig['mediaFit']) {
  if (value === 'bounded' || value === 'horizontal' || value === 'vertical') return value
  return BRAND_MEDIA_FIT_DEFAULT
}

function sidebarBrandMediaAlign(value: BrandingSidebarTopConfig['mediaAlign'], iconOnly: boolean) {
  if (value === 'start' || value === 'center' || value === 'end') return value
  return iconOnly ? 'center' : 'start'
}

function sidebarBrandJustifyClass(align: 'start' | 'center' | 'end') {
  if (align === 'center') return 'justify-center'
  if (align === 'end') return 'justify-end'
  return 'justify-start'
}

export function SidebarBrandTop({ top }: { top?: BrandingSidebarTopConfig }) {
  if (!top) return null

  const title = top.title?.trim()
  const subtitle = top.subtitle?.trim()
  const icon = top.icon?.trim()
  const logoUrl = logoSource(top)
  const hasText = Boolean(title || subtitle)
  const hasIcon = Boolean(icon)
  const hasLogo = Boolean(logoUrl)
  if (!hasText && !hasIcon && !hasLogo) return null

  const variant = renderableSidebarTopVariant(sidebarTopVariant(top), { hasLogo, hasIcon, hasText })
  if (!variant) return null
  const showLogo = Boolean(logoUrl && (variant === 'logo' || variant === 'logo-text'))
  const showIcon = Boolean(!showLogo && icon && (variant === 'icon' || variant === 'icon-text'))
  const showText = hasText && (variant === 'text' || variant === 'icon-text' || variant === 'logo-text' || (!showLogo && !showIcon))
  const iconOnly = !showText && (showLogo || showIcon)
  const ariaLabel = top.ariaLabel?.trim() || title || subtitle || t('sidebar.branding', 'Brand')
  const mediaSize = sidebarBrandMediaSize(top.mediaSize)
  const mediaFit = sidebarBrandMediaFit(top.mediaFit)
  const mediaAlign = sidebarBrandMediaAlign(top.mediaAlign, iconOnly)
  const logoStyle: CSSProperties = mediaFit === 'horizontal'
    ? { width: mediaSize, height: 'auto', maxHeight: mediaSize }
    : mediaFit === 'vertical'
      ? { height: mediaSize, width: 'auto', maxWidth: '100%' }
      : { width: mediaSize, height: mediaSize }
  const iconStyle: CSSProperties = {
    width: mediaSize,
    height: mediaSize,
    background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
  }

  return (
    <div className="px-3 pt-3 pb-2">
      <Card
        variant="flat"
        padding="sm"
        specular={false}
        className={`flex min-h-10 items-center gap-2.5 text-text-secondary ${iconOnly ? sidebarBrandJustifyClass(mediaAlign) : ''}`}
        role={iconOnly ? 'img' : undefined}
        aria-label={iconOnly ? ariaLabel : undefined}
      >
        {showLogo && (
          <img
            src={logoUrl}
            alt=""
            className={`shrink-0 rounded-md object-contain ${!iconOnly ? 'self-center' : ''}`}
            style={logoStyle}
            draggable={false}
          />
        )}
        {showIcon && (
          <span
            className={`grid shrink-0 place-items-center rounded-md border border-border-subtle text-md ${!iconOnly ? 'self-center' : ''}`}
            style={iconStyle}
            aria-hidden={iconOnly ? undefined : 'true'}
          >
            {icon}
          </span>
        )}
        {showText && (
          <div className="min-w-0 flex-1">
            {title && <div className="truncate text-xs font-medium text-text">{title}</div>}
            {subtitle && <div className="mt-0.5 truncate text-2xs text-text-muted">{subtitle}</div>}
          </div>
        )}
      </Card>
    </div>
  )
}

export function SidebarLowerBranding({ lower }: { lower?: BrandingSidebarLowerConfig }) {
  if (!lower) return null
  const text = lower.text?.trim()
  const secondaryText = lower.secondaryText?.trim()
  const linkLabel = lower.linkLabel?.trim()
  const linkUrl = safeExternalHref(lower.linkUrl)
  if (!text && !secondaryText && !(linkLabel && linkUrl)) return null

  return (
    <Card variant="flat" padding="sm" specular={false} className="mb-2 text-2xs text-text-muted">
      {text && <div className="truncate font-medium text-text-secondary">{text}</div>}
      {secondaryText && <div className="mt-0.5 line-clamp-2 leading-snug">{secondaryText}</div>}
      {linkLabel && linkUrl && (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex max-w-full text-2xs text-text-secondary hover:text-text underline-offset-2 hover:underline"
        >
          <span className="truncate">{linkLabel}</span>
        </a>
      )}
    </Card>
  )
}
