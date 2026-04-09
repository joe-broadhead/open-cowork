import ReactMarkdown from 'react-markdown'
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
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
    </div>
  )
}
