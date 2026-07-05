import type { Attachment, InlinePickerState, MentionableAgent } from './chat-input-types'
export { compactDescription } from '../../helpers/format.ts'

const HISTORY_KEY = 'open-cowork-prompt-history'
const MAX_HISTORY = 10
let attachmentIdCounter = 0

function createAttachmentId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  attachmentIdCounter += 1
  return `attachment-${Date.now().toString(36)}-${attachmentIdCounter.toString(36)}`
}

export function ensureAttachmentId(attachment: Omit<Attachment, 'id'> & { id?: string }): Attachment {
  return {
    ...attachment,
    id: attachment.id || createAttachmentId(),
  }
}

export function resolveDirectAgentInvocation(
  rawInput: string,
  availableAgents: MentionableAgent[],
): { agent: string | null; text: string } {
  const match = rawInput.match(/^@([a-z0-9-]+)\b(?:[\s,:-]+)?/i)
  if (!match?.[1]) {
    return { agent: null, text: rawInput }
  }

  const mentionedAgent = match[1].toLowerCase()
  const known = new Set(availableAgents.map((agent) => agent.id))
  if (!known.has(mentionedAgent)) {
    return { agent: null, text: rawInput }
  }

  const stripped = rawInput.slice(match[0].length).trimStart()
  return {
    agent: mentionedAgent,
    text: stripped || rawInput.trim(),
  }
}

export function detectInlineTrigger(value: string, cursor: number): Omit<InlinePickerState, 'selectedIndex'> | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)(@)([a-zA-Z0-9_-]*)$/)
  if (!match?.[1]) return null

  const trigger = match[1] as '@'
  const query = match[2] || ''
  const start = beforeCursor.length - (query.length + 1)
  return {
    trigger,
    query,
    start,
    end: cursor,
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveHistory(history: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)))
}

export async function filesToAttachments(files: FileList | File[]): Promise<Attachment[]> {
  const attachments: Attachment[] = []
  for (const file of Array.from(files)) {
    if (file.size > 20 * 1024 * 1024) continue
    const url = await fileToDataUrl(file)
    attachments.push(ensureAttachmentId({
      mime: file.type,
      url,
      filename: file.name,
      preview: file.type.startsWith('image/') ? url : undefined,
    }))
  }
  return attachments
}
