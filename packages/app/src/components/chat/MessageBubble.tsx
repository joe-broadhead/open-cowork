import { memo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { t } from '../../helpers/i18n'
import { Icon } from '@open-cowork/ui'

import type { Message } from '../../stores/session'

type Attachment = import('../../stores/session').MessageAttachment

function keyFragment(value: string) {
  return `${value.length}:${value.slice(0, 48)}:${value.slice(-48)}`
}

function attachmentRenderKey(prefix: string, attachment: Attachment, seen: Map<string, number>) {
  const base = [
    prefix,
    attachment.filename || 'unnamed',
    attachment.mime,
    keyFragment(attachment.url),
  ].join(':')
  const occurrence = seen.get(base) || 0
  seen.set(base, occurrence + 1)
  return occurrence === 0 ? base : `${base}:${occurrence + 1}`
}

function AttachmentGrid({ attachments }: { attachments: import('../../stores/session').MessageAttachment[] }) {
  const images = attachments.filter(a => a.mime.startsWith('image/'))
  const files = attachments.filter(a => !a.mime.startsWith('image/'))
  const imageKeys = new Map<string, number>()
  const fileKeys = new Map<string, number>()

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length === 1 ? 'grid-cols-1' : images.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {images.map((img) => (
            <img key={attachmentRenderKey('image', img, imageKeys)} src={img.url} alt={img.filename}
              className="rounded-lg object-cover w-full border border-border-subtle"
              style={{ maxHeight: images.length === 1 ? 300 : 160 }} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <div key={attachmentRenderKey('file', f, fileKeys)} className="chat-attachment-file">
              <Icon name="file" size={16} />
              {f.filename}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function isLivePlaceholderId(id: string) {
  return id.endsWith(':user:live') || id.endsWith(':assistant:live')
}

export const MessageBubble = memo(function MessageBubbleComponent({
  message,
  streaming = false,
  actionsEnabled = true,
}: {
  message: Message
  streaming?: boolean
  actionsEnabled?: boolean
}) {
  const isUser = message.role === 'user'
  const hasAttachments = message.attachments && message.attachments.length > 0
  const isLivePlaceholder = isLivePlaceholderId(message.id)

  if (isUser) {
    return (
      <article aria-label={t('chat.userMessageAriaLabel', 'User message')} className="group flex flex-col items-end">
        <div className="max-w-[80%] flex flex-col gap-2">
          {hasAttachments && <AttachmentGrid attachments={message.attachments!} />}
          {message.content && message.content !== 'Sent attachments' && (
            <div className="chat-user-bubble">
              {message.content}
            </div>
          )}
          {!message.content && hasAttachments && (
            <div className="chat-user-bubble opacity-70">
              Sent {message.attachments!.length} attachment{message.attachments!.length > 1 ? 's' : ''}
            </div>
          )}
          {isLivePlaceholder && (
            <div className="chat-message-sending">{t('chat.messageSending', 'Sending...')}</div>
          )}
        </div>
        {actionsEnabled && <MessageActions message={message} placement="right" />}
      </article>
    )
  }

  return (
    <article aria-label={t('chat.assistantMessageAriaLabel', 'Assistant message')} className="group flex flex-col items-start">
      <div className="max-w-[90%] flex flex-col gap-2">
        <ReasoningDisclosure
          segments={message.reasoning}
          streaming={streaming}
        />
        {message.content && <MarkdownContent text={message.content} streaming={streaming} />}
        {isLivePlaceholder && !message.content && (
          <div className="chat-message-sending">{t('chat.messageSending', 'Sending...')}</div>
        )}
      </div>
      {actionsEnabled && <MessageActions message={message} placement="left" />}
    </article>
  )
}, (prev, next) => (
  prev.message === next.message
  && prev.streaming === next.streaming
  && prev.actionsEnabled === next.actionsEnabled
))
