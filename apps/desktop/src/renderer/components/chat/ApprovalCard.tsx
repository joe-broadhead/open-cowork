import type { PendingApproval } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { Badge, Button, Card, Icon } from '../ui'

// Map tool names to user-friendly descriptions
function describeAction(tool: string, input: Record<string, unknown>): { verb: string; detail: string } {
  const name = tool.toLowerCase()
  if (name.includes('gmail') || name.includes('send') || name.includes('email')) {
    const to = input.to as string || ''
    const subject = input.subject as string || ''
    return { verb: t('approval.sendEmail', 'Send email'), detail: to ? `To: ${to}${subject ? ` — "${subject}"` : ''}` : '' }
  }
  if (name.includes('sheets') && name.includes('create')) {
    return { verb: t('approval.createSpreadsheet', 'Create spreadsheet'), detail: (input.title as string) || '' }
  }
  if (name.includes('docs') && name.includes('create')) {
    return { verb: t('approval.createDocument', 'Create document'), detail: (input.title as string) || '' }
  }
  if (name.includes('slides') && name.includes('create')) {
    return { verb: t('approval.createPresentation', 'Create presentation'), detail: (input.title as string) || '' }
  }
  if (name.includes('delete')) {
    return { verb: t('approval.delete', 'Delete'), detail: tool }
  }
  if (name.includes('share') || name.includes('permission')) {
    return { verb: t('approval.shareFile', 'Share file'), detail: (input.emailAddress as string) || '' }
  }
  if (name.includes('calendar') && name.includes('create')) {
    return { verb: t('approval.createEvent', 'Create event'), detail: (input.summary as string) || '' }
  }
  return { verb: t('approval.allowAction', 'Allow action'), detail: tool }
}

export function ApprovalCard({
  approval,
  queueCount = 1,
  onOpenSource,
}: {
  approval: PendingApproval
  queueCount?: number
  onOpenSource?: () => void
}) {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const respond = async (allowed: boolean) => {
    try {
      await window.coworkApi.permission.respond(approval.id, allowed, approval.sessionId, {
        workspaceId: approval.workspaceId || activeWorkspaceId,
      })
    } catch {
      // Permission response errors are surfaced through the session error channel.
    }
  }

  const { verb, detail } = describeAction(approval.tool, approval.input)

  return (
    <Card className="chat-approval-card overflow-hidden" padding="md">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="chat-approval-icon">
            <Icon name="alert-circle" size={16} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium text-text">{verb}</div>
              {queueCount > 1 ? <Badge tone="warning">{t('approval.queueCount', '{{count}} pending', { count: queueCount })}</Badge> : null}
            </div>
            {detail && <div className="text-2xs text-text-muted">{detail}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenSource ? (
            <Button onClick={onOpenSource} size="sm" variant="ghost" rightIcon="external-link">
              {t('approval.openSource', 'Source')}
            </Button>
          ) : null}
          <Button onClick={() => respond(false)} size="sm" variant="danger">
            {t('approval.deny', 'Deny')}
          </Button>
          <Button onClick={() => respond(true)} size="sm" variant="primary">
            {t('approval.approve', 'Approve')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
