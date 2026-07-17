/**
 * Typed security denial codes for IPC → renderer (JOE-883).
 * Prefer these over ad-hoc string throws for grant/MCP/pairing denials so the
 * renderer can show actionable recovery copy.
 */

export const IPC_SECURITY_ERROR_CODES = [
  'DIRECTORY_GRANT_REQUIRED',
  'DIRECTORY_GRANT_MISSING_PATH',
  'DIRECTORY_GRANT_NOT_DIRECTORY',
  'MCP_POLICY_REJECTED',
  'MCP_URL_REJECTED',
  'PAIRING_POLICY_DENIED',
  'PAIRING_REMOTE_NOT_ALLOWED',
  'UNTRUSTED_RENDERER_FRAME',
] as const

export type IpcSecurityErrorCode = (typeof IPC_SECURITY_ERROR_CODES)[number]

export type IpcSecurityErrorPayload = {
  code: IpcSecurityErrorCode
  message: string
  /** Optional recovery hint for UI */
  recovery?: string
}

export class IpcSecurityError extends Error {
  readonly code: IpcSecurityErrorCode
  readonly recovery?: string

  constructor(payload: IpcSecurityErrorPayload) {
    super(payload.message)
    this.name = 'IpcSecurityError'
    this.code = payload.code
    this.recovery = payload.recovery
  }

  toJSON(): IpcSecurityErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.recovery ? { recovery: this.recovery } : {}),
    }
  }
}

export function isIpcSecurityError(value: unknown): value is IpcSecurityError {
  return value instanceof IpcSecurityError
    || (
      Boolean(value)
      && typeof value === 'object'
      && (value as { name?: string }).name === 'IpcSecurityError'
      && typeof (value as { code?: unknown }).code === 'string'
    )
}

export function ipcSecurityUserMessage(error: IpcSecurityErrorPayload): string {
  const recovery = error.recovery ? ` ${error.recovery}` : ''
  return `${error.message}${recovery}`
}
