import { memo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'

import type { Message } from '../../stores/session'

function AttachmentGrid({ attachments }: { attachments: import('../../stores/session').MessageAttachment[] }) {
  const images = attachments.filter(a => a.mime.startsWith('image/'))
  const files = attachments.filter(a => !a.mime.startsWith('image/'))

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length === 1 ? 'grid-cols-1' : images.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {images.map((img, i) => (
            <img key={i} src={img.url} alt={img.filename}
              className="rounded-lg object-cover w-full border border-white/10"
              style={{ maxHeight: images.length === 1 ? 300 : 160 }} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px]"
              style={{ background: 'var(--color-surface-active)', color: 'var(--color-text-secondary)' }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z"/><polyline points="7,1 7,4 10,4"/></svg>
              {f.filename}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const MessageBubble = memo(function MessageBubble({
  message,
  streaming = false,
}: {
  message: Message
  streaming?: boolean
}) {
  const isUser = message.role === 'user'
  const hasAttachments = message.attachments && message.attachments.length > 0

  if (isUser) {
    return (
      <div className="group flex justify-end relative">
        <MessageActions message={message} placement="right" />
        <div className="max-w-[80%] flex flex-col gap-2">
          {hasAttachments && <AttachmentGrid attachments={message.attachments!} />}
          {message.content && message.content !== 'Sent attachments' && (
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-[13px] whitespace-pre-wrap self-end"
              style={{ background: 'var(--color-surface-active)', color: 'var(--color-text)' }}>
              {message.content}
            </div>
          )}
          {!message.content && hasAttachments && (
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-[13px] self-end opacity-70"
              style={{ background: 'var(--color-surface-active)', color: 'var(--color-text)' }}>
              Sent {message.attachments!.length} attachment{message.attachments!.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="group flex justify-start relative">
      <div className="max-w-[90%]">
        <MarkdownContent text={message.content} streaming={streaming} />
      </div>
      <MessageActions message={message} placement="left" />
    </div>
  )
}, (prev, next) => prev.message === next.message && prev.streaming === next.streaming)
