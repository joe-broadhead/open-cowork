import { lazy, Suspense, useEffect, useState } from 'react'
import type { BrandingSidebarConfig, BrandingSidebarLowerConfig, BrandingSidebarTopConfig } from '@open-cowork/shared'
import { ThreadList } from '../sidebar/ThreadList'
import { McpStatus } from '../sidebar/McpStatus'
import { NewThreadButton } from '../sidebar/NewThreadButton'
import { t } from '../../helpers/i18n'

interface Props {
  currentView: 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse'
  onViewChange: (view: 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse') => void
  searchRequestNonce?: number
  settingsRequestNonce?: number
  branding?: BrandingSidebarConfig
}

const SettingsPanel = lazy(() =>
  import('../sidebar/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
)

function safeLogoDataUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > 65_536) return undefined
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed) ? trimmed : undefined
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
  if (safeLogoDataUrl(top.logoDataUrl)) return top.title || top.subtitle ? 'logo-text' : 'logo'
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

function SidebarBrandTop({ top }: { top?: BrandingSidebarTopConfig }) {
  if (!top) return null

  const title = top.title?.trim()
  const subtitle = top.subtitle?.trim()
  const icon = top.icon?.trim()
  const logoDataUrl = safeLogoDataUrl(top.logoDataUrl)
  const hasText = Boolean(title || subtitle)
  const hasIcon = Boolean(icon)
  const hasLogo = Boolean(logoDataUrl)
  if (!hasText && !hasIcon && !hasLogo) return null

  const variant = renderableSidebarTopVariant(sidebarTopVariant(top), { hasLogo, hasIcon, hasText })
  if (!variant) return null
  const showLogo = Boolean(logoDataUrl && (variant === 'logo' || variant === 'logo-text'))
  const showIcon = Boolean(!showLogo && icon && (variant === 'icon' || variant === 'icon-text'))
  const showText = hasText && (variant === 'text' || variant === 'icon-text' || variant === 'logo-text' || (!showLogo && !showIcon))
  const iconOnly = !showText && (showLogo || showIcon)
  const ariaLabel = top.ariaLabel?.trim() || title || subtitle || t('sidebar.branding', 'Brand')

  return (
    <div className="px-3 pt-3 pb-2">
      <div
        className={`flex min-h-10 items-center gap-2.5 rounded-lg border border-border-subtle px-2.5 py-2 text-text-secondary ${iconOnly ? 'justify-center' : ''}`}
        style={{ background: 'color-mix(in srgb, var(--color-elevated) 42%, transparent)' }}
        role={iconOnly ? 'img' : undefined}
        aria-label={iconOnly ? ariaLabel : undefined}
      >
        {showLogo && (
          <img
            src={logoDataUrl}
            alt=""
            className="h-7 w-7 shrink-0 rounded-md object-contain"
            draggable={false}
          />
        )}
        {showIcon && (
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border-subtle text-[14px]"
            style={{ background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)' }}
            aria-hidden={iconOnly ? undefined : 'true'}
          >
            {icon}
          </span>
        )}
        {showText && (
          <div className="min-w-0 flex-1">
            {title && <div className="truncate text-[12px] font-medium text-text">{title}</div>}
            {subtitle && <div className="mt-0.5 truncate text-[10px] text-text-muted">{subtitle}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function SidebarLowerBranding({ lower }: { lower?: BrandingSidebarLowerConfig }) {
  if (!lower) return null
  const text = lower.text?.trim()
  const secondaryText = lower.secondaryText?.trim()
  const linkLabel = lower.linkLabel?.trim()
  const linkUrl = safeExternalHref(lower.linkUrl)
  if (!text && !secondaryText && !(linkLabel && linkUrl)) return null

  return (
    <div className="mb-2 rounded-md border border-border-subtle px-2 py-2 text-[11px] text-text-muted"
      style={{ background: 'color-mix(in srgb, var(--color-elevated) 34%, transparent)' }}>
      {text && <div className="truncate font-medium text-text-secondary">{text}</div>}
      {secondaryText && <div className="mt-0.5 line-clamp-2 leading-snug">{secondaryText}</div>}
      {linkLabel && linkUrl && (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex max-w-full text-[11px] text-text-secondary hover:text-text underline-offset-2 hover:underline"
        >
          <span className="truncate">{linkLabel}</span>
        </a>
      )}
    </div>
  )
}

export function Sidebar({
  currentView,
  onViewChange,
  searchRequestNonce = 0,
  settingsRequestNonce = 0,
  branding,
}: Props) {
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    if (searchRequestNonce === 0) return
    setShowSettings(false)
    setShowSearch(true)
    setSearchQuery('')
  }, [searchRequestNonce])

  useEffect(() => {
    if (settingsRequestNonce === 0) return
    setShowSearch(false)
    setSearchQuery('')
    setShowSettings(true)
  }, [settingsRequestNonce])

  return (
    <aside
      className={`flex flex-col shrink-0 border-e border-border-subtle transition-[width] duration-200 ${showSettings ? 'w-[640px]' : 'w-[252px]'}`}
      style={{ background: 'color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%)' }}
    >
      {showSettings ? (
        <Suspense fallback={<div className="p-4 text-[12px] text-text-muted">{t('settings.loading', 'Loading settings...')}</div>}>
          <SettingsPanel onClose={() => setShowSettings(false)} />
        </Suspense>
      ) : (
        <>
          <SidebarBrandTop top={branding?.top} />
          <div className="p-3 pb-1 flex gap-2">
            <div className="flex-1">
              <NewThreadButton onClick={() => onViewChange('chat')} />
            </div>
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-border-subtle transition-colors cursor-pointer ${showSearch ? 'bg-surface-active text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'}`}
              title={t('sidebar.searchTitle', 'Search threads (⌘K)')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="6" cy="6" r="4.5" />
                <line x1="9.2" y1="9.2" x2="12" y2="12" />
              </svg>
            </button>
          </div>

          {showSearch && (
            <div className="px-3 pb-1">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') } }}
                placeholder={t('sidebar.search', 'Search threads...')}
                className="w-full px-3 py-1.5 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
              />
            </div>
          )}

          <div className="px-2 pt-2 pb-1">
            <button onClick={() => onViewChange('home')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'home' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5.5 6.5 2 11 5.5V11a.75.75 0 0 1-.75.75H2.75A.75.75 0 0 1 2 11V5.5Z" />
                <path d="M5 11.75V8h3v3.75" />
              </svg>
              {t('sidebar.home', 'Home')}
            </button>
            <button onClick={() => onViewChange('agents')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'agents' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="4" r="1.5" />
                <circle cx="9" cy="4" r="1.5" />
                <path d="M1.8 10.8C2.2 9.4 3.3 8.5 4.6 8.5H5.3C6.7 8.5 7.8 9.4 8.2 10.8" />
                <path d="M7.5 10.8C7.8 9.9 8.5 9.3 9.4 9.3H9.8C10.8 9.3 11.5 9.9 11.8 10.8" />
              </svg>
              {t('sidebar.agents', 'Agents')}
            </button>
            <button onClick={() => onViewChange('automations')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'automations' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="3" height="3" rx="0.6" />
                <rect x="8" y="2" width="3" height="3" rx="0.6" />
                <rect x="2" y="8" width="3" height="3" rx="0.6" />
                <path d="M8 9.5H11" />
                <path d="M9.5 8V11" />
                <path d="M5 3.5H8" />
                <path d="M3.5 5V8" />
              </svg>
              {t('sidebar.automations', 'Automations')}
            </button>
            <button onClick={() => onViewChange('capabilities')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'capabilities' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="3.25" cy="3.25" r="1.25" />
                <circle cx="9.75" cy="3.25" r="1.25" />
                <circle cx="6.5" cy="9.75" r="1.25" />
                <path d="M4.5 3.25H8.5" />
                <path d="M4 4.2 5.8 8.7" />
                <path d="M9 4.2 7.2 8.7" />
              </svg>
              {t('sidebar.capabilities', 'Capabilities')}
            </button>
            <button onClick={() => onViewChange('pulse')}
              className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-md text-[13px] transition-colors cursor-pointer ${currentView === 'pulse' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 6.5h2.3l1.2-3 2 6 1.2-3h3.3" />
              </svg>
              {t('sidebar.pulse', 'Pulse')}
            </button>
          </div>

          {/* Threads — ThreadList owns its own scroll container so it
              can virtualize rows without fighting the parent over the
              scroll element reference. */}
          <div className="flex-1 min-h-0 flex flex-col px-2 py-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.threads', 'Threads')}</div>
            <ThreadList onSelect={() => onViewChange('chat')} searchQuery={searchQuery} />
          </div>

          {/* Connections */}
          <div className="border-t border-border-subtle px-2 py-2">
            <SidebarLowerBranding lower={branding?.lower} />
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('sidebar.connections', 'Connections')}</div>
            <McpStatus />
          </div>

          {/* Settings */}
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer border-t border-border-subtle">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" /><path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.8 2.8L3.9 3.9M10.1 10.1L11.2 11.2M11.2 2.8L10.1 3.9M3.9 10.1L2.8 11.2" />
            </svg>
            {t('sidebar.settings', 'Settings')}
          </button>
        </>
      )}
    </aside>
  )
}
