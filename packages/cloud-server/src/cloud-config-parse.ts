// Pure environment/config value parsers, extracted from cloud/app.ts so the
// config-parsing concern is separate from the app bootstrap + DI wiring. These
// have no side effects and are reused by the resolveCloud* config resolvers.

export type Env = Record<string, string | undefined>

export function envValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || null
}

export function parsePort(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid cloud port "${value}".`)
  }
  return parsed
}

export function parsePositiveInt(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer "${value}".`)
  }
  return parsed
}

export function parseOptionalPositiveInt(value: string | null | undefined, fallback: number | null) {
  if (!value) return fallback
  const parsed = Number(value)
  if (parsed === 0) return null
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer "${value}".`)
  }
  return parsed
}

export function parseBoolean(value: string | null | undefined, fallback: boolean) {
  if (!value) return fallback
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new Error(`Invalid boolean "${value}".`)
}

export function resolveEnvRef(ref: string | undefined, env: Env) {
  if (!ref) return null
  const envName = ref.startsWith('env:') ? ref.slice('env:'.length) : ref
  return envValue(env, envName)
}

export function parseCsv(value: string | null) {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) || null
}

export function parseCsvArray(value: string | null, fallback: string[] | undefined) {
  return parseCsv(value) || fallback
}

export function parseSignupMode(value: string | null | undefined) {
  if (value === 'disabled') return 'disabled'
  if (value === 'closed' || value === 'invite' || value === 'domain' || value === 'open') return value
  return null
}
