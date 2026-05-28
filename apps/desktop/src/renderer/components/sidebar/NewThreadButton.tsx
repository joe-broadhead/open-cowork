import { useEffect, useState } from 'react'
import type { WorkspaceApiSupport } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from '../../stores/session-workspace-keys'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'

function describeThreadError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportThreadError(error: unknown, view: string) {
  const message = describeThreadError(error)
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${view}: ${message}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'new-thread',
    })
  } catch {
    // Diagnostics are best-effort from an error handler; never let them
    // mask the original user-facing recovery path.
  }
}

function supportEntry(support: WorkspaceApiSupport[], api: string) {
  return support.find((entry) => entry.api === api)
}

function supportAllows(entry: WorkspaceApiSupport | undefined) {
  if (!entry) return true
  return entry.status === 'supported' || entry.status === 'read_only' || entry.verdict?.allowed === true
}

export function NewThreadButton({ onClick }: { onClick?: () => void }) {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId)
  const [showMenu, setShowMenu] = useState(false)
  const [workspaceSupportState, setWorkspaceSupportState] = useState<{
    workspaceId: string
    entries: WorkspaceApiSupport[]
    loaded: boolean
    error: string | null
  }>({
    workspaceId: 'local',
    entries: [],
    loaded: false,
    error: null,
  })

  const normalizedWorkspaceId = normalizeWorkspaceId(activeWorkspaceId)
  const activeWorkspaceIsLocal = normalizedWorkspaceId === LOCAL_WORKSPACE_ID
  const workspaceSupport = workspaceSupportState.workspaceId === normalizedWorkspaceId ? workspaceSupportState.entries : []
  const workspaceSupportLoaded = workspaceSupportState.workspaceId === normalizedWorkspaceId && workspaceSupportState.loaded
  const workspaceSupportError = workspaceSupportState.workspaceId === normalizedWorkspaceId ? workspaceSupportState.error : null
  const createSupport = supportEntry(workspaceSupport, 'sessions.create')
  const localFilesSupport = supportEntry(workspaceSupport, 'localFiles')
  const cloudCreateReason = workspaceSupportError
    || (!activeWorkspaceIsLocal && !workspaceSupportLoaded
      ? t('newThread.policyChecking', 'Checking cloud workspace policy.')
      : createSupport?.verdict?.reason || t('newThread.createBlocked', 'Thread creation is disabled by this workspace policy.'))
  const localFilesReason = localFilesSupport?.verdict?.reason || t('newThread.localFilesBlocked', 'Cloud workspaces do not implicitly upload local files.')
  const blankDisabled = (!activeWorkspaceIsLocal && (!workspaceSupportLoaded || Boolean(workspaceSupportError))) || !supportAllows(createSupport)
  const projectDisabled = !activeWorkspaceIsLocal || blankDisabled || !supportAllows(localFilesSupport)
  const projectDisabledReason = blankDisabled ? cloudCreateReason : localFilesReason
  const blankHint = activeWorkspaceIsLocal
    ? t('newThread.blankHint', 'Local workspace - start with Build and the currently available agents, tools, and skills')
    : t('newThread.blankCloudHint', 'Cloud-safe action - start a synced cloud thread')
  const projectHint = projectDisabled
    ? `${t('newThread.localOnlyAction', 'Local-only action')} - ${projectDisabledReason}`
    : t('newThread.projectHint', 'Local-only action - choose a directory the agent can read and edit')

  useEffect(() => {
    let cancelled = false
    setWorkspaceSupportState({
      workspaceId: normalizedWorkspaceId,
      entries: [],
      loaded: false,
      error: null,
    })
    window.coworkApi.workspace.support(normalizedWorkspaceId)
      .then((support) => {
        if (!cancelled) {
          setWorkspaceSupportState({
            workspaceId: normalizedWorkspaceId,
            entries: support,
            loaded: true,
            error: null,
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceSupportState({
            workspaceId: normalizedWorkspaceId,
            entries: [],
            loaded: true,
            error: t('newThread.policyUnavailable', 'Could not load this workspace policy.'),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [normalizedWorkspaceId])

  const createThread = async (directory?: string) => {
    if (directory && projectDisabled) {
      addGlobalError(projectDisabledReason)
      setShowMenu(false)
      return
    }
    try {
      const workspaceOptions = activeWorkspaceIsLocal ? undefined : { workspaceId: normalizedWorkspaceId }
      const session = workspaceOptions
        ? await window.coworkApi.session.create(directory, workspaceOptions)
        : await window.coworkApi.session.create(directory)
      addSession(session)
      setCurrentSession(session.id)
      if (workspaceOptions) {
        await window.coworkApi.session.activate(session.id, workspaceOptions)
      } else {
        await window.coworkApi.session.activate(session.id)
      }
      onClick?.()
    } catch (err) {
      addGlobalError(t('newThread.createFailed', 'Could not create a new thread. Please try again.'))
      reportThreadError(err, `Failed to create session${directory ? ` for ${directory}` : ''}`)
    }
    setShowMenu(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-secondary rounded-lg border border-border-subtle hover:bg-surface-hover hover:text-text transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="6" y1="2" x2="6" y2="10" />
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
        {t('sidebar.newThread', 'New Thread')}
      </button>

      {showMenu && (
        <>
          <ModalBackdrop onDismiss={() => setShowMenu(false)} className="fixed inset-0 z-40" />
          <div
            className="absolute start-0 end-0 top-full mt-1 z-50 rounded-xl overflow-hidden theme-popover"
          >
            <button
              onClick={() => createThread()}
              disabled={blankDisabled}
              title={blankDisabled ? cloudCreateReason : undefined}
              className="w-full text-start px-3 py-2.5 text-[12px] text-text hover:bg-surface-hover cursor-pointer transition-colors flex items-center gap-2.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-text-muted">
                <circle cx="7" cy="7" r="5" />
                <path d="M7 4.5v5M4.5 7h5" />
              </svg>
              <div>
                <div className="font-medium">{t('newThread.blank', 'Blank thread')}</div>
                <div className="text-[10px] text-text-muted mt-px">{blankHint}</div>
              </div>
            </button>
            <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
            <button
              onClick={async () => {
                if (projectDisabled) {
                  addGlobalError(projectDisabledReason)
                  setShowMenu(false)
                  return
                }
                try {
                  const dir = await window.coworkApi.dialog.selectDirectory()
                  if (dir) createThread(dir)
                  else setShowMenu(false)
                } catch (err) {
                  addGlobalError(t('newThread.projectPickerFailed', 'Could not open the project picker. Please try again.'))
                  reportThreadError(err, 'Failed to open project picker')
                  setShowMenu(false)
                }
              }}
              disabled={projectDisabled}
              title={projectDisabled ? projectDisabledReason : undefined}
              className="w-full text-start px-3 py-2.5 text-[12px] text-text hover:bg-surface-hover cursor-pointer transition-colors flex items-center gap-2.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                <path d="M2 3.5C2 2.67 2.67 2 3.5 2H5.5L7 3.5H10.5C11.33 3.5 12 4.17 12 5V10.5C12 11.33 11.33 12 10.5 12H3.5C2.67 12 2 11.33 2 10.5V3.5Z" />
              </svg>
              <div>
                <div className="font-medium">{t('newThread.project', 'Open Project')}</div>
                <div className="text-[10px] text-text-muted mt-px">{projectHint}</div>
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
