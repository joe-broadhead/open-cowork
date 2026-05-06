type PromptAttachmentInput = {
  mime: string
  url: string
  filename?: string
}

const MAX_PROMPT_TEXT_BYTES = 1_000_000
const MAX_PROMPT_ATTACHMENTS = 10
const MAX_PROMPT_ATTACHMENT_URL_BYTES = 30 * 1024 * 1024
const MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_PROMPT_ATTACHMENT_MIME_BYTES = 256
const MAX_PROMPT_ATTACHMENT_FILENAME_BYTES = 512
const MAX_PROMPT_AGENT_BYTES = 128
const MAX_SESSION_ID_BYTES = 256
const MAX_COMMAND_NAME_BYTES = 256
const MAX_SESSION_TITLE_BYTES = 512
export const MAX_FILE_SNIPPET_BYTES = 5 * 1024 * 1024
const DATA_URL_PREFIX = 'data:'
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9_.+-]+=[a-z0-9_.+-]+)*$/i
const DATA_URL_RE = /^data:([^,;]+(?:;[^,;=]+=[^,;]+)*);base64,[A-Za-z0-9+/]*={0,2}$/i

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function requireBoundedString(value: unknown, fieldName: string, maxBytes: number) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`)
  }
  if (byteLength(value) > maxBytes) {
    throw new Error(`${fieldName} exceeds ${maxBytes} bytes`)
  }
  return value
}

function assertPromptAttachmentDataUrl(url: string, mime: string, index: number) {
  if (!MIME_TYPE_RE.test(mime)) {
    throw new Error(`Prompt attachment ${index + 1} MIME type is invalid`)
  }
  if (!url.startsWith(DATA_URL_PREFIX)) {
    throw new Error(`Prompt attachment ${index + 1} URL must be a base64 data URL`)
  }
  const match = DATA_URL_RE.exec(url)
  if (!match) {
    throw new Error(`Prompt attachment ${index + 1} URL must be a base64 data URL`)
  }
  if (match[1]?.toLowerCase() !== mime.toLowerCase()) {
    throw new Error(`Prompt attachment ${index + 1} data URL MIME type must match its declared MIME type`)
  }
}

export function normalizePromptText(text: unknown) {
  return requireBoundedString(text, 'Prompt text', MAX_PROMPT_TEXT_BYTES)
}

export function normalizePromptAgent(agent: unknown) {
  if (agent == null || agent === '') return 'build'
  return requireBoundedString(agent, 'Prompt agent', MAX_PROMPT_AGENT_BYTES)
}

export function normalizeSessionId(value: unknown) {
  const sessionId = requireBoundedString(value, 'Session id', MAX_SESSION_ID_BYTES).trim()
  if (!sessionId) throw new Error('Session id is required')
  return sessionId
}

export function normalizeCommandName(value: unknown) {
  const commandName = requireBoundedString(value, 'Command name', MAX_COMMAND_NAME_BYTES).trim()
  if (!commandName) throw new Error('Command name is required')
  return commandName
}

export function normalizeSessionTitle(value: unknown) {
  const title = requireBoundedString(value, 'Session title', MAX_SESSION_TITLE_BYTES).trim()
  if (!title) throw new Error('Session title is required')
  return title
}

export function normalizePromptAttachments(attachments: unknown): PromptAttachmentInput[] {
  if (attachments == null) return []
  if (!Array.isArray(attachments)) {
    throw new Error('Prompt attachments must be an array')
  }
  if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
    throw new Error(`Prompt attachments exceed ${MAX_PROMPT_ATTACHMENTS} files`)
  }

  let totalBytes = 0
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new Error(`Prompt attachment ${index + 1} must be an object`)
    }
    const record = attachment as Record<string, unknown>
    const mime = requireBoundedString(record.mime, `Prompt attachment ${index + 1} MIME type`, MAX_PROMPT_ATTACHMENT_MIME_BYTES)
    const url = requireBoundedString(record.url, `Prompt attachment ${index + 1} URL`, MAX_PROMPT_ATTACHMENT_URL_BYTES)
    const filename = record.filename == null
      ? undefined
      : requireBoundedString(record.filename, `Prompt attachment ${index + 1} filename`, MAX_PROMPT_ATTACHMENT_FILENAME_BYTES)
    assertPromptAttachmentDataUrl(url, mime, index)

    totalBytes += byteLength(mime) + byteLength(url) + (filename ? byteLength(filename) : 0)
    if (totalBytes > MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(`Prompt attachments exceed ${MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES} total bytes`)
    }

    return filename === undefined
      ? { mime, url }
      : { mime, url, filename }
  })
}
