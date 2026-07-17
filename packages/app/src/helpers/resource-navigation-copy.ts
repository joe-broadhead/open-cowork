/**
 * Map technical resource navigation status to user-facing recovery copy (JOE-891).
 */
export function resourceNavigationUserMessage(status: string | null | undefined): string {
  const key = (status || '').trim().toLowerCase()
  switch (key) {
    case 'not_found':
    case 'missing':
      return 'That resource was not found. It may have been deleted or is outside this workspace.'
    case 'forbidden':
    case 'denied':
    case 'unauthorized':
      return 'You do not have access to that resource. Switch workspace or ask an admin.'
    case 'offline':
    case 'unavailable':
      return 'The workspace is offline. Reconnect, then open Health Center if the problem continues.'
    case 'timeout':
      return 'The request timed out. Try again in a moment.'
    default:
      if (!key) return 'Could not open that resource.'
      return `Could not open that resource (${status}). Try again or open Health Center for diagnostics.`
  }
}
