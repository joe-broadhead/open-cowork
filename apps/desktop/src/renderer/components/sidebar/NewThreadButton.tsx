import { useState } from 'react'
import type {
  CloudProjectSnapshotInventory,
  CloudProjectSourceInput,
} from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from '../../stores/session-workspace-keys'
import { supportEntry, supportAllows, useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'
import { Button, Card, Icon, IconButton, Input, SegmentedControl } from '../ui'

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
  const workspaceSupportState = useActiveWorkspaceSupport()

  const normalizedWorkspaceId = normalizeWorkspaceId(activeWorkspaceId)
  const activeWorkspaceIsLocal = normalizedWorkspaceId === LOCAL_WORKSPACE_ID
  const workspaceSupport = workspaceSupportState.workspaceId === normalizedWorkspaceId ? workspaceSupportState.support : []
  const workspaceSupportLoaded = workspaceSupportState.workspaceId === normalizedWorkspaceId && workspaceSupportState.loaded
  const workspaceSupportError = workspaceSupportState.workspaceId === normalizedWorkspaceId ? workspaceSupportState.error : null
  const canExposeLocalPaths = workspaceSupportState.workspaceId === normalizedWorkspaceId
    ? workspaceSupportState.flags.canExposeLocalPaths
    : false
  const createSupport = supportEntry(workspaceSupport, 'sessions.create')
  const localFilesSupport = supportEntry(workspaceSupport, 'localFiles')
  const cloudCreateReason = workspaceSupportError
    || (!activeWorkspaceIsLocal && !workspaceSupportLoaded
      ? t('newThread.policyChecking', 'Checking cloud workspace policy.')
      : createSupport?.verdict?.reason || t('newThread.createBlocked', 'Chat creation is disabled by this workspace policy.'))
  const localFilesReason = localFilesSupport?.verdict?.reason || t('newThread.localFilesBlocked', 'Cloud workspaces do not implicitly upload local files.')
  const blankDisabled = (!activeWorkspaceIsLocal && (!workspaceSupportLoaded || Boolean(workspaceSupportError))) || !supportAllows(createSupport, { mutation: true })
  const projectDisabled = canExposeLocalPaths
    ? blankDisabled || !supportAllows(localFilesSupport, { mutation: true })
    : blankDisabled
  const projectDisabledReason = blankDisabled
    ? cloudCreateReason
    : canExposeLocalPaths
      ? localFilesReason
      : null
  const blankDisabledReason = cloudCreateReason || t('newChat.blankUnavailableReason', 'Chat creation is unavailable for this workspace.')
  const blankHint = blankDisabled
    ? `${t('newChat.unavailable', 'Unavailable')} - ${blankDisabledReason}`
    : canExposeLocalPaths
      ? t('newChat.blankHint', 'Local workspace - start with Build and the currently available coworkers, tools, and skills')
      : t('newChat.blankCloudHint', 'Cloud-safe action - start a synced cloud chat')
  const projectHint = projectDisabled
    ? `${canExposeLocalPaths ? t('newChat.localOnlyAction', 'Local-only action') : t('newChat.cloudAction', 'Cloud action')} - ${projectDisabledReason || ''}`
    : canExposeLocalPaths
      ? t('newChat.projectHint', 'Local-only action - choose a project directory the coworker can read and edit')
      : t('newChat.cloudProjectHint', 'Cloud-safe action - choose Git or upload an explicit snapshot')
  const createProjectDisabledReason = projectMode === 'snapshot' && !snapshotInventory && !projectBusy
    ? t('newThread.snapshotRequired', 'Choose a snapshot directory first.')
    : null

  const closeProjectDialog = () => {
    setShowCloudProjectDialog(false)
    setProjectError(null)
    setProjectBusy(false)
  }

  const createThread = async (directory?: string, projectSource?: CloudProjectSourceInput | null) => {
    if ((directory || projectSource) && projectDisabled) {
      addGlobalError(projectDisabledReason || t('newChat.projectBlocked', 'Project chat creation is disabled.'))
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
      addGlobalError(t('newChat.createFailed', 'Could not create a new project chat. Please try again.'))
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
      reportThreadError(err, 'Failed to create cloud git chat')
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
      reportThreadError(err, 'Failed to create cloud snapshot chat')
    } finally {
      setProjectBusy(false)
    }
  }

  return (
    <div className="relative">
      <Button
        onClick={() => setShowMenu(!showMenu)}
        variant="secondary"
        size="sm"
        fullWidth
        leftIcon="plus"
        className="new-thread-trigger"
      >
        {t('sidebar.newChat', 'New Chat')}
      </Button>

      {showMenu && (
        <>
          <ModalBackdrop onDismiss={() => setShowMenu(false)} className="fixed inset-0 z-40" />
          <div
            className="absolute start-0 end-0 top-full mt-1 z-50 rounded-xl overflow-hidden theme-popover"
          >
            <Card
              interactive
              padding="sm"
              onClick={() => createThread()}
              disabled={blankDisabled}
              className="new-thread-menu-option"
            >
              <Icon name="plus" size={16} className="text-text-muted" />
              <div>
                <div className="font-medium">{t('newChat.blank', 'Blank chat')}</div>
                <div className="text-[10px] text-text-muted mt-px">{blankHint}</div>
              </div>
            </Card>
            <div className="new-thread-menu-separator" />
            <Card
              interactive
              padding="sm"
              onClick={async () => {
                if (projectDisabled) {
                  addGlobalError(projectDisabledReason || t('newChat.projectBlocked', 'Project chat creation is disabled.'))
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
              className="new-thread-menu-option"
            >
              <Icon name="folder" size={16} className="text-text-muted" />
              <div>
                <div className="font-medium">{t('newThread.project', 'Open Project')}</div>
                <div className="text-[10px] text-text-muted mt-px">{projectHint}</div>
              </div>
            </Card>
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
                <div className="text-[11px] text-text-muted mt-1">{t('newChat.cloudProjectSubtitle', 'Start a cloud project chat from Git or an explicit uploaded snapshot.')}</div>
              </div>
              <IconButton
                icon="x"
                label={t('common.close', 'Close')}
                onClick={closeProjectDialog}
                size="sm"
              />
            </div>

            <SegmentedControl
              className="mt-4 w-full"
              label={t('newThread.cloudProjectSourceMode', 'Cloud project source mode')}
              value={projectMode}
              onChange={(value) => setProjectMode(value as 'git' | 'snapshot')}
              options={[
                { value: 'git', label: t('newThread.gitSource', 'Git source') },
                { value: 'snapshot', label: t('newThread.snapshotSource', 'Uploaded snapshot') },
              ]}
            />

            {projectMode === 'git' ? (
              <div className="mt-4 space-y-3">
                <Input
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  aria-label={t('newThread.gitUrlLabel', 'Git repository URL')}
                  size="sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={gitRef}
                    onChange={(event) => setGitRef(event.target.value)}
                    placeholder={t('newThread.gitRefPlaceholder', 'branch, tag, or commit')}
                    aria-label={t('newThread.gitRefLabel', 'Git ref')}
                    size="sm"
                  />
                  <Input
                    value={gitSubdirectory}
                    onChange={(event) => setGitSubdirectory(event.target.value)}
                    placeholder={t('newThread.gitSubdirPlaceholder', 'subdirectory')}
                    aria-label={t('newThread.gitSubdirLabel', 'Git subdirectory')}
                    size="sm"
                  />
                </div>
                <Input
                  value={gitCredentialRef}
                  onChange={(event) => setGitCredentialRef(event.target.value)}
                  placeholder={t('newThread.gitCredentialPlaceholder', 'credential ref')}
                  aria-label={t('newThread.gitCredentialLabel', 'Git credential reference')}
                  size="sm"
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <Button
                  type="button"
                  onClick={chooseSnapshotDirectory}
                  disabled={projectBusy}
                  fullWidth
                  size="sm"
                  variant="secondary"
                >
                  {snapshotDirectory
                    ? t('newThread.chooseDifferentSnapshot', 'Choose different directory')
                    : t('newThread.chooseSnapshot', 'Choose directory')}
                </Button>
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
              <div className="new-thread-error mt-3 rounded-md border px-3 py-2 text-[12px]">
                {projectError}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                onClick={closeProjectDialog}
                size="sm"
                variant="ghost"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                disabled={projectBusy}
                disabledReason={createProjectDisabledReason}
                onClick={projectMode === 'git' ? createGitCloudThread : createSnapshotCloudThread}
                size="sm"
                variant="primary"
                loading={projectBusy}
              >
                {t('newChat.createCloudProject', 'Create project chat')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
