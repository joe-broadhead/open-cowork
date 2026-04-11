import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
  },
}

function CopyButton({ text }: { text: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
  }

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
      style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}
    >
      Copy
    </button>
  )
}

export function MarkdownContent({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  return (
    <div className={`text-[13px] prose prose-p:my-1 prose-p:last:mb-0 prose-headings:my-2 prose-headings:last:mb-0 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 text-text leading-relaxed ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeHighlight]}
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
          code: ({ className: codeClassName, children, ...props }) => {
            const isBlock = codeClassName?.startsWith('language-') || codeClassName?.startsWith('hljs')
            if (isBlock) return <code className={codeClassName} {...props}>{children}</code>
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
    </div>
  )
}

function extractText(children: any): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (children?.props?.children) return extractText(children.props.children)
  return ''
}
