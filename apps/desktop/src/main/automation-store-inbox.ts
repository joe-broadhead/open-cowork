import type { AutomationInboxItem } from '@open-cowork/shared'
import { getDb, withTransaction } from './automation-store-db.ts'
import { rowToInbox, type DbRow } from './automation-store-model.ts'

export function createInboxItem(input: {
  automationId: string
  runId?: string | null
  sessionId?: string | null
  questionId?: string | null
  type: AutomationInboxItem['type']
  title: string
  body: string
  promoteAutomationStatus?: boolean
}) {
  const id = crypto.randomUUID()
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare(`
      insert into automation_inbox (id, automation_id, run_id, session_id, question_id, type, status, title, body, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(id, input.automationId, input.runId || null, input.sessionId || null, input.questionId || null, input.type, input.title, input.body, now, now)
    const shouldPromote = input.promoteAutomationStatus ?? (
      input.type === 'clarification'
      || input.type === 'approval'
      || input.type === 'failure'
    )
    if (shouldPromote) {
      db.prepare('update automations set status = ?, updated_at = ? where id = ?').run('needs_user', now, input.automationId)
    }
  })
  return getInboxItem(id)
}

export function getInboxItem(itemId: string) {
  const row = getDb().prepare('select * from automation_inbox where id = ?').get(itemId) as DbRow | undefined
  return row ? rowToInbox(row) : null
}

export function resolveInboxItem(itemId: string, status: AutomationInboxItem['status']) {
  getDb().prepare('update automation_inbox set status = ?, updated_at = ? where id = ?').run(status, new Date().toISOString(), itemId)
  return getInboxItem(itemId)
}

export function listOpenInboxForAutomation(automationId: string, type?: AutomationInboxItem['type']) {
  if (type) {
    return (getDb().prepare('select * from automation_inbox where automation_id = ? and type = ? and status = ? order by updated_at desc').all(automationId, type, 'open') as DbRow[]).map(rowToInbox)
  }
  return (getDb().prepare('select * from automation_inbox where automation_id = ? and status = ? order by updated_at desc').all(automationId, 'open') as DbRow[]).map(rowToInbox)
}

export function openInboxItemsForQuestion(questionId: string) {
  return (getDb().prepare('select * from automation_inbox where question_id = ? and status = ?').all(questionId, 'open') as DbRow[]).map(rowToInbox)
}

export function listInboxForSession(sessionId: string) {
  return (getDb().prepare('select * from automation_inbox where session_id = ? and status = ?').all(sessionId, 'open') as DbRow[]).map(rowToInbox)
}
