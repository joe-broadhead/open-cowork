import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '../../stores/session'

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
    <div className="flex justify-start">
      <div className="max-w-[90%] text-[13px] prose text-text leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeHighlight]}
          components={{
            // Code blocks
            pre: ({ children, ...props }) => (
              <pre className="code-block" {...props}>{children}</pre>
            ),
            code: ({ className, children, ...props }) => {
              const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
              if (isBlock) {
                return <code className={className} {...props}>{children}</code>
              }
              return <code className="inline-code" {...props}>{children}</code>
            },
            // Tables
            table: ({ children, ...props }) => (
              <div className="table-wrap">
                <table {...props}>{children}</table>
              </div>
            ),
            // Links
            a: ({ children, href, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
            ),
            // Details/summary (collapsible sections)
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
    </div>
  )
}
