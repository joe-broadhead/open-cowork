import { useState } from 'react'
import { useSessionStore } from '../../stores/session'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'

// Allow details/summary but strip all event handlers and javascript: URIs
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
  },
}
import type { Message } from '../../stores/session'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button onClick={handleCopy} className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
      style={{ background: 'var(--color-surface-hover)', color: copied ? 'var(--color-green)' : 'var(--color-text-muted)' }}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer"
      style={{ color: copied ? 'var(--color-green)' : 'var(--color-text-muted)' }}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

function ForkButton({ messageId }: { messageId: string }) {
  const [forking, setForking] = useState(false)
  const handleFork = async () => {
    setForking(true)
    try {
      const state = useSessionStore.getState()
      const currentSessionId = state.currentSessionId
      if (!currentSessionId) return

      // Fork the session (without messageID — forks from current state)
      const forked = await window.cowork.session.fork(currentSessionId)
      if (forked) {
        state.addSession(forked)
        state.setCurrentSession(forked.id)
        state.clearMessages()
        // Load messages for the forked session
        const messages = await window.cowork.session.messages(forked.id)
        for (const msg of messages) {
          state.addMessage({ id: msg.id, role: msg.role as 'user' | 'assistant', content: msg.content })
        }
      }
    } catch (err) {
      console.error('Fork failed:', err)
    } finally {
      setForking(false)
    }
  }
  return (
    <button onClick={handleFork} disabled={forking}
      className="px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer"
      style={{ color: 'var(--color-text-muted)' }}
      title="Fork thread from this point">
      {forking ? '...' : '⑂ Fork'}
    </button>
  )
}

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
              style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z"/><polyline points="7,1 7,4 10,4"/></svg>
              {f.filename}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const hasAttachments = message.attachments && message.attachments.length > 0

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] flex flex-col gap-2">
          {hasAttachments && <AttachmentGrid attachments={message.attachments!} />}
          {message.content && message.content !== 'Sent attachments' && (
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-[13px] whitespace-pre-wrap self-end"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--color-text)' }}>
              {message.content}
            </div>
          )}
          {!message.content && hasAttachments && (
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm text-[13px] self-end opacity-70"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--color-text)' }}>
              Sent {message.attachments!.length} attachment{message.attachments!.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderMarkdown = (text: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeHighlight]}
      components={{
        pre: ({ children, ...props }) => {
          const codeText = extractText(children)
          return (
            <div className="relative group/code">
              <pre className="code-block" {...props}>{children}</pre>
              <CopyButton text={codeText} />
            </div>
          )
        },
        code: ({ className, children, ...props }) => {
          const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
          if (isBlock) return <code className={className} {...props}>{children}</code>
          return <code className="inline-code" {...props}>{children}</code>
        },
        table: ({ children, ...props }) => (
          <div className="table-wrap"><table {...props}>{children}</table></div>
        ),
        a: ({ children, href, ...props }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
        ),
        details: ({ children, ...props }) => (
          <details className="details-block" {...props}>{children}</details>
        ),
        summary: ({ children, ...props }) => (
          <summary className="details-summary" {...props}>{children}</summary>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )

  return (
    <div className="flex justify-start group">
      <div className="max-w-[90%]">
        <div className="text-[13px] prose text-text leading-relaxed">
          {renderMarkdown(message.content)}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
          <MessageCopyButton text={message.content} />
          <ForkButton messageId={message.id} />
        </div>
      </div>
    </div>
  )
}

// Extract text content from React children (for copy button)
function extractText(children: any): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (children?.props?.children) return extractText(children.props.children)
  return ''
}
