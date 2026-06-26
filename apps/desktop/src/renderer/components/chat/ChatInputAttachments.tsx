import type { Attachment } from './chat-input-types'
import { Icon, IconButton } from '../ui'

type ChatInputAttachmentsProps = {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

export function ChatInputAttachments({ attachments, onRemove }: ChatInputAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex gap-2 mb-2.5 flex-wrap">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="relative group/att">
          {attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.filename}
              className="chat-attachment-preview h-20 rounded-xl object-cover border border-border"
            />
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-elevated text-2xs">
              <Icon name="file" size={16} className="text-text-muted" />
              <span className="chat-attachment-name text-text-secondary truncate">
                {attachment.filename}
              </span>
              <span className="text-text-muted">{attachment.mime.split('/')[1]}</span>
            </div>
          )}
          <IconButton
            icon="x"
            label={`Remove ${attachment.filename}`}
            onClick={() => onRemove(attachment.id)}
            size="sm"
            variant="danger"
            className="absolute -top-2 -end-2"
          />
        </div>
      ))}
    </div>
  )
}
