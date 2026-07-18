const secretPatterns = [
  /(api[_-]?key|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi,
  /(occ(?:i)?_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+)/g,
  /(sk-[A-Za-z0-9_-]{12,})/g,
]

const localPathPatterns = [
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,
]

export function sanitizeChannelText(value: string, maxLength = 512): string {
  let sanitized = value
  for (const pattern of secretPatterns) {
    sanitized = sanitized.replace(pattern, (_match, left?: string) => {
      return left && /api|token|secret|password|credential/i.test(left)
        ? `${left}=[redacted]`
        : '[redacted]'
    })
  }
  for (const pattern of localPathPatterns) {
    sanitized = sanitized.replace(pattern, (match) => {
      const prefix = match.match(/^(\/Users|\/home|[A-Z]:\\Users)/i)?.[0] || '[home]'
      return `${prefix}/[redacted]`
    })
  }
  sanitized = sanitized
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join('')
  return sanitized.length > maxLength
    ? `${sanitized.slice(0, Math.max(0, maxLength - 15)).trimEnd()}\n...[truncated]`
    : sanitized
}
