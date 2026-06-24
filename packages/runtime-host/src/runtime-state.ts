import type { OpencodeClient as V2OpencodeClient } from '@opencode-ai/sdk/v2'
import type { ModelInfoSnapshot } from '@open-cowork/shared'
import type { ManagedOpencodeServerAuth } from './runtime-managed-server.js'

export const MAX_DIRECTORY_CLIENTS = 10_000

type DirectoryClientHandler = (directory: string, client: V2OpencodeClient) => void

export class RuntimeState {
  private client: V2OpencodeClient | null = null
  private serverUrl: string | null = null
  private serverAuth: ManagedOpencodeServerAuth | null = null
  private serverClose: (() => void) | null = null
  private tokenRefreshTimer: NodeJS.Timeout | null = null
  private startRuntimePromise: Promise<V2OpencodeClient> | null = null
  private directoryClients = new Map<string, V2OpencodeClient>()
  private activeProjectOverlayDirectory: string | null = null
  private onDirectoryClientCreated: DirectoryClientHandler | null = null
  private onDirectoryClientEvicted: DirectoryClientHandler | null = null
  private orphanCleanupComplete = false
  private currentRuntimePid: number | null = null
  private cachedModelInfo: ModelInfoSnapshot | null = null
  private modelInfoPromise: Promise<void> | null = null

  getClient() {
    return this.client
  }

  setClient(client: V2OpencodeClient | null) {
    this.client = client
  }

  getServerUrl() {
    return this.serverUrl
  }

  setServerUrl(serverUrl: string | null) {
    this.serverUrl = serverUrl
  }

  getServerAuth() {
    return this.serverAuth
  }

  setServerAuth(serverAuth: ManagedOpencodeServerAuth | null) {
    this.serverAuth = serverAuth
  }

  setServerClose(serverClose: (() => void) | null) {
    this.serverClose = serverClose
  }

  takeServerClose() {
    const close = this.serverClose
    this.serverClose = null
    return close
  }

  getStartRuntimePromise() {
    return this.startRuntimePromise
  }

  setStartRuntimePromise(promise: Promise<V2OpencodeClient> | null) {
    this.startRuntimePromise = promise
  }

  clearStartRuntimePromise() {
    this.startRuntimePromise = null
  }

  stopTokenRefreshTimer() {
    if (!this.tokenRefreshTimer) return
    clearInterval(this.tokenRefreshTimer)
    this.tokenRefreshTimer = null
  }

  setTokenRefreshTimer(timer: NodeJS.Timeout | null) {
    this.stopTokenRefreshTimer()
    this.tokenRefreshTimer = timer
  }

  getDirectoryClients(): ReadonlyMap<string, V2OpencodeClient> {
    return this.directoryClients
  }

  getDirectoryClientCacheForRuntime() {
    return this.directoryClients
  }

  setDirectoryClient(directory: string, client: V2OpencodeClient) {
    this.directoryClients.set(directory, client)
  }

  clearDirectoryClients() {
    this.directoryClients.clear()
  }

  getActiveProjectOverlayDirectory() {
    return this.activeProjectOverlayDirectory
  }

  setActiveProjectOverlayDirectory(directory: string | null) {
    this.activeProjectOverlayDirectory = directory
  }

  getDirectoryClientCreatedHandler() {
    return this.onDirectoryClientCreated
  }

  getDirectoryClientEvictedHandler() {
    return this.onDirectoryClientEvicted
  }

  setDirectoryClientLifecycleHandlers(handlers: {
    onCreate?: DirectoryClientHandler | null
    onEvict?: DirectoryClientHandler | null
  }) {
    this.onDirectoryClientCreated = handlers.onCreate || null
    this.onDirectoryClientEvicted = handlers.onEvict || null
  }

  isOrphanCleanupComplete() {
    return this.orphanCleanupComplete
  }

  markOrphanCleanupComplete() {
    this.orphanCleanupComplete = true
  }

  setCurrentRuntimePid(pid: number | null) {
    this.currentRuntimePid = pid
  }

  takeCurrentRuntimePid() {
    const pid = this.currentRuntimePid
    this.currentRuntimePid = null
    return pid
  }

  getCachedModelInfo() {
    return this.cachedModelInfo
  }

  setCachedModelInfo(modelInfo: ModelInfoSnapshot | null) {
    this.cachedModelInfo = modelInfo
  }

  getModelInfoPromise() {
    return this.modelInfoPromise
  }

  setModelInfoPromise(promise: Promise<void> | null) {
    this.modelInfoPromise = promise
  }

  resetRuntimeSessionState() {
    this.client = null
    this.serverUrl = null
    this.serverAuth = null
    this.serverClose = null
    this.currentRuntimePid = null
    this.cachedModelInfo = null
    this.modelInfoPromise = null
    this.activeProjectOverlayDirectory = null
    this.directoryClients.clear()
  }

  resetAfterStop() {
    this.clearStartRuntimePromise()
    this.stopTokenRefreshTimer()
    this.resetRuntimeSessionState()
  }
}

export const runtimeState = new RuntimeState()
