import type {
  OpencodeClient as V2OpencodeClient,
  OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'
import { log } from '@open-cowork/shared/node'
import { resolve } from 'node:path'
import {
  buildAuthenticatedOpencodeV2ClientConfig,
  createOpencodeV2Client,
} from './opencode-client-kernel.js'
import { getOrCreateDirectoryClient } from './runtime-client-cache.js'
import type { ManagedOpencodeServerAuth } from './runtime-managed-server.js'
import { getRuntimeHomeDir } from './runtime-paths.js'
import { MAX_DIRECTORY_CLIENTS, runtimeState } from './runtime-state.js'

function normalizeDirectory(directory?: string | null) {
  return directory ? resolve(directory) : null
}

export function buildManagedOpencodeClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeServerAuth,
  directory?: string | null,
): OpencodeClientConfig & { directory?: string } {
  return buildAuthenticatedOpencodeV2ClientConfig(baseUrl, auth, directory)
}

export function getClient(): V2OpencodeClient | null {
  return runtimeState.getClient()
}

export function getClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  const normalized = normalizeDirectory(directory)
  const serverUrl = runtimeState.getServerUrl()
  const serverAuth = runtimeState.getServerAuth()
  return getOrCreateDirectoryClient({
    baseClient: runtimeState.getClient(),
    serverUrl,
    directory: normalized,
    runtimeHomeDir: normalizeDirectory(getRuntimeHomeDir()),
    cache: runtimeState.getDirectoryClientCacheForRuntime(),
    maxEntries: MAX_DIRECTORY_CLIENTS,
    createClient: (baseUrl, scopedDirectory) =>
      createOpencodeV2Client(serverAuth
        ? buildManagedOpencodeClientConfig(baseUrl, serverAuth, scopedDirectory)
        : { baseUrl, directory: scopedDirectory }),
    onCreate: (scopedClient, scopedDirectory) => {
      runtimeState.getDirectoryClientCreatedHandler()?.(scopedDirectory, scopedClient)
    },
    onEvict: (scopedClient, scopedDirectory) => {
      log('runtime', `Evicting directory-scoped OpenCode client for ${scopedDirectory}`)
      runtimeState.getDirectoryClientEvictedHandler()?.(scopedDirectory, scopedClient)
    },
  })
}

export function setDirectoryClientLifecycleHandlers(handlers: {
  onCreate?: ((directory: string, client: V2OpencodeClient) => void) | null
  onEvict?: ((directory: string, client: V2OpencodeClient) => void) | null
}) {
  runtimeState.setDirectoryClientLifecycleHandlers(handlers)
}
