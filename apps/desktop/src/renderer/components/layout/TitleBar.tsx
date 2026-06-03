import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { IconButton } from '../ui'

export function TitleBar() {
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)

  return (
    <div className="drag flex items-center h-[38px] shrink-0 select-none border-b border-border-subtle">
      <div className="flex items-center pl-[72px] gap-1.5">
        <IconButton
          icon="panel-left"
          label={t('titleBar.toggleSidebar', 'Toggle sidebar')}
          onClick={toggleSidebar}
          size="sm"
          className="no-drag"
        />
      </div>
      <div className="flex-1" />
      <div className="w-[100px]" />
    </div>
  )
}
