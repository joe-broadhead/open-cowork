import { useState } from 'react'

interface Props {
  error: string
  onRestart: () => Promise<void>
}

// Surfaced at the top of the app window when the OpenCode runtime
// transitions from ready → not-ready after boot. Previously these
// failures were silent: the chat composer kept accepting input, the
// sidebar kept showing stale sessions, and prompts would timeout
// with a generic "An error occurred." This banner makes the state
// explicit and gives the user a one-click recovery affordance.
//
// The restart path is `runtime.restart()`, which in the main process
// is the same `rebootRuntime()` singleton used by
// `custom:add-mcp` / `settings:set` post-save — concurrent clicks
// coalesce so the button is cheap to mash.
export function RuntimeOfflineBanner({ error, onRestart }: Props) {
  const [restarting, setRestarting] = useState(false)

  const handleRestart = async () => {
    if (restarting) return
    setRestarting(true)
    try {
      await onRestart()
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="assertive"
      className="flex items-center justify-between gap-3 px-4 py-2 text-[12px]"
      style={{
        background: 'color-mix(in srgb, var(--color-red) 12%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--color-red) 30%, var(--color-border-subtle))',
        color: 'var(--color-red)',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="shrink-0">
          <circle cx="7" cy="7" r="5.5" />
          <line x1="7" y1="4.5" x2="7" y2="7.5" />
          <circle cx="7" cy="9.5" r="0.4" fill="currentColor" />
        </svg>
        <span className="truncate">
          Runtime unavailable: <span className="font-mono text-[11px]">{error}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => void handleRestart()}
        disabled={restarting}
        className="shrink-0 px-3 py-1 rounded border text-[11px] font-medium cursor-pointer disabled:opacity-60 disabled:cursor-wait"
        style={{
          borderColor: 'color-mix(in srgb, var(--color-red) 50%, transparent)',
          color: 'var(--color-red)',
          background: 'color-mix(in srgb, var(--color-red) 6%, transparent)',
        }}
      >
        {restarting ? 'Restarting…' : 'Try again'}
      </button>
    </div>
  )
}
