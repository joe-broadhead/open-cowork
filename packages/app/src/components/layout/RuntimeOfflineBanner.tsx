import { useState } from 'react'
import { t } from '../../helpers/i18n'
import { Button, Icon } from '../ui'

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
      className="flex items-center justify-between gap-3 border-b border-red/30 bg-red/12 px-4 py-2 text-xs text-red"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="alert-circle" size={16} className="shrink-0" />
        <span className="truncate">
          {t('runtime.offlineLabel', 'Runtime unavailable:')}{' '}
          <span className="font-mono text-2xs">{error}</span>
        </span>
      </div>
      <Button
        variant="danger"
        size="sm"
        onClick={() => void handleRestart()}
        loading={restarting}
        className="shrink-0"
      >
        {restarting ? t('runtime.restarting', 'Restarting…') : t('runtime.tryAgain', 'Try again')}
      </Button>
    </div>
  )
}
