import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
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
      className="opacity-0 group-hover:opacity-100 mt-1 px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer"
      style={{ color: copied ? 'var(--color-green)' : 'var(--color-text-muted)' }}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-accent text-white text-[13px] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start group">
      <div className="max-w-[90%]">
        <div className="text-[13px] prose text-text leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, rehypeHighlight]}
            components={{
              pre: ({ children, ...props }) => {
                // Extract text from code children for copy button
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
            {message.content}
          </ReactMarkdown>
        </div>
        <MessageCopyButton text={message.content} />
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
