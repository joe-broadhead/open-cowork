const icons: Record<string, JSX.Element> = {
  google: (
    <svg width="22" height="22" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  nova: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#1a1a2e"/>
      <rect x="6" y="14" width="3" height="6" rx="0.5" fill="#4285F4"/>
      <rect x="10.5" y="10" width="3" height="10" rx="0.5" fill="#34A853"/>
      <rect x="15" y="6" width="3" height="14" rx="0.5" fill="#EA4335"/>
    </svg>
  ),
  search: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7"/>
      <line x1="16.5" y1="16.5" x2="21" y2="21"/>
    </svg>
  ),
  code: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16,18 22,12 16,6"/>
      <polyline points="8,6 2,12 8,18"/>
    </svg>
  ),
}

export function PluginIcon({ icon, size = 40 }: { icon: string; size?: number }) {
  const svg = icons[icon]
  if (svg) {
    return (
      <div className="rounded-xl bg-elevated border border-border flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
        {svg}
      </div>
    )
  }
  // Fallback: emoji or first letter
  return (
    <div className="rounded-xl bg-elevated border border-border flex items-center justify-center shrink-0" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {icon.length <= 2 ? icon : icon[0].toUpperCase()}
    </div>
  )
}
