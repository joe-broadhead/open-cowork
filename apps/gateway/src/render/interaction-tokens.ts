export type ParsedGatewayInteractionToken =
  | { action: 'approve', token: string }
  | { action: 'deny', token: string }
  | { action: 'answer', token: string, answer: string }
  | { action: 'reject', token: string }
  | { action: 'default', token: string }

export function approvalToken(token: string): string {
  return `apv:${token}`
}

export function denialToken(token: string): string {
  return `den:${token}`
}

export function answerToken(token: string, answer: string): string {
  return `ans:${Buffer.from(answer, 'utf8').toString('base64url')}:${token}`
}

export function rejectionToken(token: string): string {
  return `rej:${token}`
}

export function parseGatewayInteractionToken(value: string): ParsedGatewayInteractionToken {
  const token = value.trim()
  if (token.startsWith('apv:')) return { action: 'approve', token: token.slice(4) }
  if (token.startsWith('den:')) return { action: 'deny', token: token.slice(4) }
  if (token.startsWith('rej:')) return { action: 'reject', token: token.slice(4) }
  if (token.startsWith('ans:')) {
    const rest = token.slice(4)
    const separator = rest.indexOf(':')
    if (separator > 0) {
      const encoded = rest.slice(0, separator)
      const rawToken = rest.slice(separator + 1)
      return {
        action: 'answer',
        token: rawToken,
        answer: Buffer.from(encoded, 'base64url').toString('utf8'),
      }
    }
  }
  return { action: 'default', token }
}
