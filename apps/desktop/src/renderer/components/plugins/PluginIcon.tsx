const icons: Record<string, (size: number) => JSX.Element> = {
  google: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  nova: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#1a1a2e"/>
      <rect x="6" y="14" width="3" height="6" rx="0.5" fill="#4285F4"/>
      <rect x="10.5" y="10" width="3" height="10" rx="0.5" fill="#34A853"/>
      <rect x="15" y="6" width="3" height="14" rx="0.5" fill="#EA4335"/>
    </svg>
  ),
  atlassian: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
      <path d="M14.84 3.27a1.08 1.08 0 00-1.96.09L8.52 14.22a1.03 1.03 0 01-.95.65H3.71a.99.99 0 00-.9 1.42l2.9 5.78a1.07 1.07 0 001.96-.08l1.83-4.57 2.06-5.14 3.28 6.42c.18.35.55.57.95.57h3.85a1 1 0 00.89-1.45L14.84 3.27z" fill="#2684FF"/>
      <path d="M22.2 17.82L18.52 10.6a1.02 1.02 0 00-.92-.55h-3.84a.99.99 0 00-.9 1.43l2.34 4.58 1.4 2.74c.18.35.54.57.94.57h3.77a1 1 0 00.9-1.45z" fill="#0052CC"/>
    </svg>
  ),
  amplitude: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
      <path d="M11.5 4a3.5 3.5 0 013.5 3.5V19a3 3 0 11-6 0V7.5A3.5 3.5 0 0111.5 4z" fill="#005AF0"/>
      <circle cx="17.5" cy="8.5" r="2.5" fill="#005AF0"/>
    </svg>
  ),
  github: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
      <path d="M12 2.5C6.76 2.5 2.5 6.76 2.5 12c0 4.2 2.72 7.76 6.49 9.02.47.09.64-.2.64-.46 0-.22-.01-.96-.01-1.74-2.38.43-2.99-.58-3.18-1.11-.11-.27-.56-1.11-.96-1.33-.33-.18-.8-.62-.01-.63.74-.01 1.27.68 1.44.96.84 1.41 2.18 1.01 2.71.77.08-.61.33-1.01.59-1.24-2.11-.24-4.31-1.05-4.31-4.69 0-1.04.37-1.89.98-2.56-.1-.24-.43-1.22.09-2.54 0 0 .8-.26 2.62.98.76-.21 1.57-.31 2.38-.31s1.62.1 2.38.31c1.82-1.25 2.62-.98 2.62-.98.52 1.32.19 2.3.09 2.54.61.67.98 1.51.98 2.56 0 3.65-2.21 4.45-4.32 4.69.34.29.63.85.63 1.72 0 1.24-.01 2.24-.01 2.55 0 .25.17.55.65.45A9.51 9.51 0 0021.5 12c0-5.24-4.26-9.5-9.5-9.5z" fill="#0f172a"/>
    </svg>
  ),
  perplexity: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4.5V8.2M12 15.8V19.5M4.5 12H8.2M15.8 12H19.5M6.9 6.9L9.5 9.5M14.5 14.5L17.1 17.1M17.1 6.9L14.5 9.5M9.5 14.5L6.9 17.1"
        stroke="#22B8A5"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M12 7.8L14.1 9.9L16.2 12L14.1 14.1L12 16.2L9.9 14.1L7.8 12L9.9 9.9L12 7.8Z"
        stroke="#22B8A5"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill="#22B8A5"/>
    </svg>
  ),
  'github-mcp': (s) => icons.github(s),
  'google-sheets': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" fill="#0F9D58"/><path d="M14.5 2v5.5H20L14.5 2z" fill="#87CEAC"/><rect x="7" y="12" width="10" height="1.5" rx=".3" fill="#fff" opacity=".7"/><rect x="7" y="15" width="10" height="1.5" rx=".3" fill="#fff" opacity=".7"/><rect x="11.5" y="12" width="1.5" height="4.5" rx=".3" fill="#fff" opacity=".5"/></svg>
  ),
  'google-docs': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" fill="#4285F4"/><path d="M14.5 2v5.5H20L14.5 2z" fill="#A1C2FA"/><rect x="7" y="12" width="10" height="1" rx=".3" fill="#fff" opacity=".7"/><rect x="7" y="14.5" width="7" height="1" rx=".3" fill="#fff" opacity=".7"/><rect x="7" y="17" width="9" height="1" rx=".3" fill="#fff" opacity=".7"/></svg>
  ),
  'google-slides': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" fill="#F4B400"/><path d="M14.5 2v5.5H20L14.5 2z" fill="#F7D67B"/><rect x="7" y="11" width="10" height="7" rx="1" fill="#fff" opacity=".7"/></svg>
  ),
  'google-drive': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M8 21l-4-7h8l4 7H8z" fill="#4285F4"/><path d="M16 21l4-7H12L8 21h8z" fill="#0F9D58"/><path d="M12 14L8 7h8l4 7H12z" fill="#F4B400"/><path d="M8 7l4 7L8 21 4 14l4-7z" fill="#4285F4" opacity=".1"/></svg>
  ),
  gmail: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" fill="#fff"/><path d="M2 7l10 6 10-6" stroke="#EA4335" strokeWidth="1.5" fill="none"/><rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="#D93025" strokeWidth=".5"/></svg>
  ),
  'google-gmail': (s) => icons.gmail(s),
  'google-calendar': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" fill="#fff" stroke="#4285F4" strokeWidth="1"/><rect x="3" y="4" width="18" height="5" rx="2" fill="#4285F4"/><text x="12" y="17" textAnchor="middle" fill="#4285F4" fontSize="8" fontWeight="bold" fontFamily="Arial">31</text></svg>
  ),
  'google-chat': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M12 3C6.48 3 2 6.58 2 11c0 2.5 1.3 4.7 3.3 6.2L4 21l4.3-2.2c1.1.4 2.4.6 3.7.6 5.52 0 10-3.58 10-8s-4.48-8-10-8z" fill="#0F9D58"/><circle cx="8" cy="11" r="1.2" fill="#fff"/><circle cx="12" cy="11" r="1.2" fill="#fff"/><circle cx="16" cy="11" r="1.2" fill="#fff"/></svg>
  ),
  'google-people': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="#4285F4"><circle cx="12" cy="8" r="4"/><path d="M12 14c-5 0-8 2.5-8 5v1h16v-1c0-2.5-3-5-8-5z"/></svg>
  ),
  'google-forms': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" fill="#7248B9"/><path d="M14.5 2v5.5H20L14.5 2z" fill="#B39DDB"/><circle cx="8.5" cy="13" r="1" fill="#fff" opacity=".7"/><rect x="11" y="12.5" width="6" height="1" rx=".3" fill="#fff" opacity=".7"/><circle cx="8.5" cy="16" r="1" fill="#fff" opacity=".7"/><rect x="11" y="15.5" width="6" height="1" rx=".3" fill="#fff" opacity=".7"/></svg>
  ),
  'google-keep': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" fill="#FBBC05"/><rect x="8" y="7" width="8" height="1" rx=".3" fill="#fff" opacity=".7"/><rect x="8" y="10" width="6" height="1" rx=".3" fill="#fff" opacity=".7"/></svg>
  ),
  'google-tasks': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="#4285F4"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
  ),
  'google-appscript': (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="#4285F4"/><text x="12" y="15" textAnchor="middle" fill="#fff" fontSize="8" fontWeight="bold" fontFamily="monospace">{'{}'}</text></svg>
  ),
  search: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
  ),
  code: (s) => (
    <svg width={s * 0.55} height={s * 0.55} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></svg>
  ),
}

export function PluginIcon({ icon, size = 40 }: { icon: string; size?: number }) {
  const renderer = icons[icon]
  if (renderer) {
    return (
      <div className="rounded-xl bg-elevated border border-border flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
        {renderer(size)}
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-elevated border border-border flex items-center justify-center shrink-0 text-text-muted" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {icon.length <= 2 ? icon : icon[0].toUpperCase()}
    </div>
  )
}
