export type CredentialFieldType = 'text' | 'select' | 'radio'

export interface CredentialFieldOption {
  label: string
  value: string
  hint?: string
}

export interface CredentialFieldCondition {
  key: string
  op: 'eq' | 'neq'
  value: string
}

export interface CredentialField {
  key: string
  label: string
  description: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  env?: string
  runtimeKey?: string
  type?: CredentialFieldType
  options?: CredentialFieldOption[]
  when?: CredentialFieldCondition
}

export function credentialFieldIsVisible(
  credential: Pick<CredentialField, 'when'>,
  values: Record<string, string | null | undefined>,
) {
  if (!credential.when) return true
  const actual = values[credential.when.key] ?? ''
  return credential.when.op === 'eq'
    ? actual === credential.when.value
    : actual !== credential.when.value
}

// Per-model pricing + context info cached by the main process after
// fetching `client.provider.list()`. The renderer uses this to render
// per-message cost estimates and context-usage hints.
export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
  cacheWritePer1M?: number
}

export interface ModelInfoSnapshot {
  pricing: Record<string, ModelPricing>
  contextLimits: Record<string, number>
}

export interface ProviderModelDescriptor {
  id: string
  name: string
  description?: string
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  featured?: boolean
  contextLength?: number
}

export interface ProviderDescriptor {
  id: string
  name: string
  description: string
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
  defaultModel?: string
  connected?: boolean
}

export type ProviderAuthPrompt =
  | {
    type: 'text'
    key: string
    message: string
    placeholder?: string
    when?: {
      key: string
      op: 'eq' | 'neq'
      value: string
    }
  }
  | {
    type: 'select'
    key: string
    message: string
    options: Array<{
      label: string
      value: string
      hint?: string
    }>
    when?: {
      key: string
      op: 'eq' | 'neq'
      value: string
    }
  }

export interface ProviderAuthMethod {
  type: 'oauth' | 'api'
  label: string
  prompts?: ProviderAuthPrompt[]
}

export interface ProviderAuthAuthorization {
  url: string
  method: 'auto' | 'code'
  instructions: string
}

export interface RuntimeProviderDescriptor {
  id?: string
  name?: string
  models?: Record<string, unknown>
  defaultModel?: string
  connected?: boolean
}
