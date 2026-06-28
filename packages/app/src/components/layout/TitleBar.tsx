import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { IconButton } from '../ui'
import type { AppView } from '../../app-types'

// Breadcrumb label for the current screen. The window title bar carries the
// breadcrumb + a translucent blur (prototype .topbar), adapted to the desktop's
// window-chrome height rather than a separate 62px content bar.
const VIEW_BREADCRUMB: Partial<Record<AppView, { key: string; fallback: string }>> = {
  home: { key: 'sidebar.home', fallback: 'Home' },
  chat: { key: 'titleBar.chat', fallback: 'Chat' },
  projects: { key: 'sidebar.projects', fallback: 'Projects' },
  knowledge: { key: 'sidebar.knowledge', fallback: 'Knowledge' },
  approvals: { key: 'sidebar.approvals', fallback: 'Approvals' },
  playbooks: { key: 'sidebar.playbooks', fallback: 'Playbooks' },
  team: { key: 'sidebar.team', fallback: 'Team' },
  channels: { key: 'sidebar.channels', fallback: 'Channels' },
  tools: { key: 'sidebar.toolsSkills', fallback: 'Tools & Skills' },
  artifacts: { key: 'sidebar.artifacts', fallback: 'Artifacts' },
}

export function TitleBar({ view }: { view?: AppView }) {
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)
  const crumb = view ? VIEW_BREADCRUMB[view] : undefined

  return (
    <div className="title-bar drag flex items-center h-[38px] shrink-0 select-none border-b border-border-subtle">
      <div className="flex items-center pl-[72px] gap-2">
        <IconButton
          icon="panel-left"
          label={t('titleBar.toggleSidebar', 'Toggle sidebar')}
          onClick={toggleSidebar}
          size="sm"
          className="no-drag"
        />
        {crumb ? (
          <span className="truncate text-sm font-semibold text-text">{t(crumb.key, crumb.fallback)}</span>
        ) : null}
      </div>
      <div className="flex-1" />
      <div className="w-[100px]" />
    </div>
  )
}
