import type { CloudAuthConfig, CloudBillingConfig, OpenCoworkConfig } from '@open-cowork/shared'
import type { BillingAdapter } from './billing-adapter.ts'
import {
  envValue,
  parseBoolean,
  resolveEnvRef,
  type Env,
} from './cloud-config-parse.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import { InMemoryControlPlaneStore } from './in-memory-control-plane-store.ts'
import type { ObjectStoreAdapter } from './object-store.ts'
import type { PathProvider } from './path-provider.ts'
import { createPostgresControlPlaneStore } from './postgres-control-plane-store.ts'
import { resolveCloudSecretRef } from './secret-adapter.ts'
import { isManagedCloudSecretRef } from './secret-ref-policy.ts'
import { createStripeBillingAdapter } from './stripe-billing-adapter.ts'
import { createStubBillingAdapter } from './stub-billing-adapter.ts'

export const RUN_MIGRATIONS_ENV = 'OPEN_COWORK_CLOUD_RUN_MIGRATIONS'
export const SSE_PG_NOTIFY_ENV = 'OPEN_COWORK_CLOUD_SSE_PG_NOTIFY'

export type CloudControlPlaneStoreFactoryInput = {
  config: OpenCoworkConfig
  env: Env
}

export type CloudControlPlaneStoreFactory = (
  input: CloudControlPlaneStoreFactoryInput,
) => Promise<ControlPlaneStore> | ControlPlaneStore

export type CloudObjectStoreFactoryInput = {
  config: OpenCoworkConfig
  env: Env
  paths: PathProvider
}

export type CloudObjectStoreFactory = (
  input: CloudObjectStoreFactoryInput,
) => Promise<ObjectStoreAdapter> | ObjectStoreAdapter

async function resolveConfiguredSecretRef(ref: string | null | undefined, env: Env) {
  const value = ref?.trim()
  if (!value) return null
  if (value.startsWith('env:') || isManagedCloudSecretRef(value)) {
    return resolveCloudSecretRef(value, { env })
  }
  return resolveEnvRef(value, env)
}

async function resolveCloudSecretMaterial(input: {
  value?: string | null
  ref?: string | null
  env: Env
}) {
  const direct = input.value?.trim()
  if (direct) return direct
  return resolveConfiguredSecretRef(input.ref, input.env)
}

export async function resolveCloudAuthRuntimeSecrets(
  auth: CloudAuthConfig,
  env: Env,
): Promise<CloudAuthConfig> {
  if (auth.mode !== 'header') return auth
  const headerSecret = await resolveCloudSecretMaterial({
    value: auth.headerSecret,
    ref: auth.headerSecretRef,
    env,
  })
  return {
    ...auth,
    headerSecret: headerSecret || auth.headerSecret,
  }
}

export function resolveCloudControlPlaneUrl(
  config: OpenCoworkConfig,
  env: Env = process.env,
) {
  return envValue(env, 'OPEN_COWORK_CLOUD_CONTROL_PLANE_URL')
    || resolveEnvRef(config.cloud.storage.controlPlane.urlRef, env)
}

export function resolveCloudCookieSecret(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
) {
  const cookieSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF')
    || config.cloud.auth.cookieSecretRef
  return envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
    || resolveEnvRef(cookieSecretRef, env)
    || envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
}

export async function resolveCloudCookieSecretForRuntime(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
) {
  const cookieSecret = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
  if (cookieSecret) return cookieSecret
  const cookieSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF')
    || config.cloud.auth.cookieSecretRef
  const resolvedCookieSecret = await resolveConfiguredSecretRef(cookieSecretRef, env)
  if (resolvedCookieSecret) return resolvedCookieSecret
  const cloudSecret = envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
  if (cloudSecret) return cloudSecret
  return resolveConfiguredSecretRef(envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY_REF'), env)
}

export async function createBillingAdapterForCloud(input: {
  config: CloudBillingConfig
  env: Env
}): Promise<BillingAdapter | null> {
  if (!input.config.enabled || input.config.provider === 'none') return null
  if (input.config.provider === 'stub') return createStubBillingAdapter(input.config)
  if (input.config.provider === 'stripe') {
    const apiKey = envValue(input.env, 'OPEN_COWORK_CLOUD_STRIPE_API_KEY')
      || resolveEnvRef(input.config.stripe?.apiKeyRef, input.env)
    const webhookSecret = envValue(input.env, 'OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET')
      || resolveEnvRef(input.config.stripe?.webhookSecretRef, input.env)
    return createStripeBillingAdapter({
      config: input.config,
      apiKey,
      webhookSecret,
    })
  }
  return null
}

export function resolveCloudOidcClientSecret(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
) {
  const clientSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF')
    || config.cloud.auth.clientSecretRef
  return envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
    || resolveEnvRef(clientSecretRef, env)
}

export async function resolveCloudOidcClientSecretForRuntime(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
) {
  const clientSecret = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
  if (clientSecret) return clientSecret
  const clientSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF')
    || config.cloud.auth.clientSecretRef
  return resolveConfiguredSecretRef(clientSecretRef, env)
}

export function resolveCloudInternalToken(env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_INTERNAL_TOKEN')
    || resolveEnvRef(envValue(env, 'OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF') || undefined, env)
}

export async function createControlPlaneStoreForCloud(
  input: CloudControlPlaneStoreFactoryInput,
): Promise<ControlPlaneStore> {
  const url = resolveCloudControlPlaneUrl(input.config, input.env)
  if (input.config.cloud.storage.controlPlane.kind === 'postgres' || url) {
    if (!url) {
      throw new Error('Cloud control plane is configured for Postgres but no connection URL is available.')
    }
    // Allow change-managed rollouts to boot instances with embedded migrations
    // disabled and run `cloud:migrate` as a separate step.
    return createPostgresControlPlaneStore({
      connectionString: url,
      runMigrations: parseBoolean(envValue(input.env, RUN_MIGRATIONS_ENV), true),
      ssePgNotify: parseBoolean(envValue(input.env, SSE_PG_NOTIFY_ENV), false),
    })
  }
  return new InMemoryControlPlaneStore()
}
