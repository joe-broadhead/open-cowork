import { useEffect, useState } from 'react'
import type {
  CloudProjectSnapshotInventory,
  CloudProjectSourceInput,
  WorkspaceApiSupport,
} from '@open-cowork/shared'
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
  const [showCloudProjectDialog, setShowCloudProjectDialog] = useState(false)
  const [projectMode, setProjectMode] = useState<'git' | 'snapshot'>('git')
  const [gitUrl, setGitUrl] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [gitSubdirectory, setGitSubdirectory] = useState('')
  const [gitCredentialRef, setGitCredentialRef] = useState('')
  const [snapshotDirectory, setSnapshotDirectory] = useState<string | null>(null)
  const [snapshotInventory, setSnapshotInventory] = useState<CloudProjectSnapshotInventory | null>(null)
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
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
  const projectDisabled = activeWorkspaceIsLocal
    ? blankDisabled || !supportAllows(localFilesSupport)
    : blankDisabled
  const projectDisabledReason = blankDisabled
    ? cloudCreateReason
    : activeWorkspaceIsLocal
      ? localFilesReason
      : null
  const blankHint = activeWorkspaceIsLocal
    ? t('newThread.blankHint', 'Local workspace - start with Build and the currently available agents, tools, and skills')
    : t('newThread.blankCloudHint', 'Cloud-safe action - start a synced cloud thread')
  const projectHint = projectDisabled
    ? `${activeWorkspaceIsLocal ? t('newThread.localOnlyAction', 'Local-only action') : t('newThread.cloudAction', 'Cloud action')} - ${projectDisabledReason || ''}`
    : activeWorkspaceIsLocal
      ? t('newThread.projectHint', 'Local-only action - choose a directory the agent can read and edit')
      : t('newThread.cloudProjectHint', 'Cloud-safe action - choose Git or upload an explicit snapshot')

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

  const closeProjectDialog = () => {
    setShowCloudProjectDialog(false)
    setProjectError(null)
    setProjectBusy(false)
  }

  const createThread = async (directory?: string, projectSource?: CloudProjectSourceInput | null) => {
    if ((directory || projectSource) && projectDisabled) {
      addGlobalError(projectDisabledReason || t('newThread.projectBlocked', 'Project thread creation is disabled.'))
      setShowMenu(false)
      return
    }
    try {
      const workspaceOptions = activeWorkspaceIsLocal ? undefined : {
        workspaceId: normalizedWorkspaceId,
        ...(projectSource ? { projectSource } : {}),
      }
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
      closeProjectDialog()
    } catch (err) {
      addGlobalError(t('newThread.createFailed', 'Could not create a new thread. Please try again.'))
      reportThreadError(err, `Failed to create session${directory ? ` for ${directory}` : ''}`)
    }
    setShowMenu(false)
  }

  const createGitCloudThread = async () => {
    const repositoryUrl = gitUrl.trim()
    if (!repositoryUrl) {
      setProjectError(t('newThread.gitUrlRequired', 'Git repository URL is required.'))
      return
    }
    setProjectBusy(true)
    setProjectError(null)
    try {
      const projectSource: CloudProjectSourceInput = {
        kind: 'git',
        repositoryUrl,
        ref: gitRef.trim() || null,
        subdirectory: gitSubdirectory.trim() || null,
        credentialRef: gitCredentialRef.trim() || null,
      }
      const verdict = await window.coworkApi.projectSource.validate({
        workspaceId: normalizedWorkspaceId,
        projectSource,
      })
      if (!verdict.allowed) {
        setProjectError(verdict.reason || t('newThread.gitBlocked', 'Git source is blocked by workspace policy.'))
        setProjectBusy(false)
        return
      }
      await createThread(undefined, projectSource)
    } catch (err) {
      setProjectError(describeThreadError(err))
      reportThreadError(err, 'Failed to create cloud git thread')
    } finally {
      setProjectBusy(false)
    }
  }

  const chooseSnapshotDirectory = async () => {
    setProjectError(null)
    const directory = await window.coworkApi.dialog.selectDirectory()
    if (!directory) return
    setProjectBusy(true)
    try {
      const inventory = await window.coworkApi.projectSource.snapshotInventory({ directory })
      setSnapshotDirectory(directory)
      setSnapshotInventory(inventory)
    } catch (err) {
      setProjectError(describeThreadError(err))
      reportThreadError(err, 'Failed to inventory project snapshot')
    } finally {
      setProjectBusy(false)
    }
  }

  const createSnapshotCloudThread = async () => {
    if (!snapshotDirectory || !snapshotInventory) {
      setProjectError(t('newThread.snapshotRequired', 'Choose a snapshot directory first.'))
      return
    }
    setProjectBusy(true)
    setProjectError(null)
    try {
      const uploaded = await window.coworkApi.projectSource.uploadSnapshot({
        workspaceId: normalizedWorkspaceId,
        directory: snapshotDirectory,
      })
      await createThread(undefined, uploaded.projectSource)
    } catch (err) {
      setProjectError(describeThreadError(err))
      reportThreadError(err, 'Failed to create cloud snapshot thread')
    } finally {
      setProjectBusy(false)
    }
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
                  addGlobalError(projectDisabledReason || t('newThread.projectBlocked', 'Project thread creation is disabled.'))
                  setShowMenu(false)
                  return
                }
                if (!activeWorkspaceIsLocal) {
                  setShowMenu(false)
                  setShowCloudProjectDialog(true)
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
              title={projectDisabled ? projectDisabledReason || undefined : undefined}
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
      {showCloudProjectDialog && (
        <>
          <ModalBackdrop onDismiss={closeProjectDialog} className="fixed inset-0 z-50" />
          <div className="fixed inset-x-4 top-20 z-[60] mx-auto max-w-[520px] rounded-xl theme-popover p-4 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-text">{t('newThread.cloudProjectTitle', 'Cloud project source')}</div>
                <div className="text-[11px] text-text-muted mt-1">{t('newThread.cloudProjectSubtitle', 'Start a cloud thread from Git or an explicit uploaded snapshot.')}</div>
              </div>
              <button
                type="button"
                onClick={closeProjectDialog}
                className="px-2 py-1 text-[12px] rounded-md text-text-muted hover:bg-surface-hover"
              >
                {t('common.close', 'Close')}
              </button>
            </div>

            <div
              className="mt-4 grid grid-cols-2 gap-2 rounded-lg p-1"
              style={{ background: 'var(--color-surface-hover)' }}
            >
              <button
                type="button"
                onClick={() => setProjectMode('git')}
                className={`rounded-md px-3 py-1.5 text-[12px] ${projectMode === 'git' ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
              >
                {t('newThread.gitSource', 'Git source')}
              </button>
              <button
                type="button"
                onClick={() => setProjectMode('snapshot')}
                className={`rounded-md px-3 py-1.5 text-[12px] ${projectMode === 'snapshot' ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
              >
                {t('newThread.snapshotSource', 'Uploaded snapshot')}
              </button>
            </div>

            {projectMode === 'git' ? (
              <div className="mt-4 space-y-3">
                <input
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-border"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={gitRef}
                    onChange={(event) => setGitRef(event.target.value)}
                    placeholder={t('newThread.gitRefPlaceholder', 'branch, tag, or commit')}
                    className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-border"
                  />
                  <input
                    value={gitSubdirectory}
                    onChange={(event) => setGitSubdirectory(event.target.value)}
                    placeholder={t('newThread.gitSubdirPlaceholder', 'subdirectory')}
                    className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-border"
                  />
                </div>
                <input
                  value={gitCredentialRef}
                  onChange={(event) => setGitCredentialRef(event.target.value)}
                  placeholder={t('newThread.gitCredentialPlaceholder', 'credential ref')}
                  className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-border"
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <button
                  type="button"
                  onClick={chooseSnapshotDirectory}
                  disabled={projectBusy}
                  className="w-full rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text hover:bg-surface-hover disabled:opacity-50"
                >
                  {snapshotDirectory
                    ? t('newThread.chooseDifferentSnapshot', 'Choose different directory')
                    : t('newThread.chooseSnapshot', 'Choose directory')}
                </button>
                {snapshotInventory && (
                  <div className="rounded-lg border border-border-subtle p-3 text-[11px] text-text-muted">
                    <div className="text-text">
                      {snapshotInventory.fileCount} {t('newThread.files', 'files')} · {Math.ceil(snapshotInventory.byteCount / 1024)} KB
                    </div>
                    <div className="mt-1">
                      {snapshotInventory.excluded.length} {t('newThread.excludedFiles', 'excluded by policy')}
                    </div>
                    {snapshotInventory.warnings.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {snapshotInventory.warnings.map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {projectError && (
              <div
                className="mt-3 rounded-md border px-3 py-2 text-[12px]"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-red) 35%, transparent)',
                  background: 'color-mix(in srgb, var(--color-red) 10%, transparent)',
                  color: 'var(--color-red)',
                }}
              >
                {projectError}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeProjectDialog}
                className="rounded-md px-3 py-2 text-[12px] text-text-muted hover:bg-surface-hover"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                disabled={projectBusy || (projectMode === 'snapshot' && !snapshotInventory)}
                onClick={projectMode === 'git' ? createGitCloudThread : createSnapshotCloudThread}
                className="rounded-md bg-accent px-3 py-2 text-[12px] font-medium text-accent-foreground disabled:opacity-50"
              >
                {projectBusy ? t('common.working', 'Working...') : t('newThread.createCloudProject', 'Create thread')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
