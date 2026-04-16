import type { Attachment } from './chat-input-types'

type ChatInputAttachmentsProps = {
  attachments: Attachment[]
  onRemove: (index: number) => void
}

export function ChatInputAttachments({ attachments, onRemove }: ChatInputAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex gap-2 mb-2.5 flex-wrap">
      {attachments.map((attachment, index) => (
        <div key={`${attachment.filename}:${index}`} className="relative group/att">
          {attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.filename}
              className="h-20 rounded-xl object-cover border border-border"
              style={{ maxWidth: 200 }}
            />
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-elevated text-[11px]">
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.2">
                <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
                <polyline points="7,1 7,4 10,4" />
              </svg>
              <span className="text-text-secondary truncate" style={{ maxWidth: 120 }}>
                {attachment.filename}
              </span>
              <span className="text-text-muted">{attachment.mime.split('/')[1]}</span>
            </div>
          )}
          <button
            onClick={() => onRemove(index)}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold opacity-0 group-hover/att:opacity-100 cursor-pointer transition-opacity"
            style={{ background: 'var(--color-red)', color: 'var(--color-accent-foreground)' }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}
