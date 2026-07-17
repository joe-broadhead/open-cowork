// Browser implementation of the renderer's `window.coworkApi` bridge.
//
// The desktop renderer is written entirely against the fully-typed `CoworkAPI`
// surface (see `@open-cowork/shared` → `CoworkAPI`). On Electron the preload
// supplies that object over IPC. This module supplies the SAME `CoworkAPI`
// backed by the cloud HTTP + SSE API, so a browser build of the renderer can
// run unchanged against the cloud control plane.
//
// IMPORTANT: this file must ONLY be imported by the future browser entry point.
// It must never be reachable from the Electron renderer (`index.tsx`) or any
// module the Electron build loads — it speaks `fetch`/`EventSource`, not IPC.
//
// Design notes:
//   * Self-contained transport. The minimal fetch/CSRF/401 + SSE helpers live
//     here so the renderer's browser build depends only on the cloud HTTP API
//     surface, never on a server-side package.
//   * Envelope (un)wrapping. The cloud routes return data in their own
//     envelopes (`{ providers }`, `{ session, projection, view }`, …); each
//     method unwraps/rewraps to the shape `CoworkAPI` declares.
//   * Events. The cloud exposes a workspace SSE stream + per-session SSE
//     streams. We multiplex those into the per-channel `on.*` callbacks the
//     renderer subscribes to — the same `window.coworkApi.on.*` surface the
//     Electron preload bridge supplies on desktop.
//   * Electron-only methods (native dialogs, runtime restart, desktop pairing,
//     updates, local OAuth, FS imports, app reset) have no cloud equivalent.
//     They are implemented as signature-satisfying stubs that either use a
//     browser primitive where one exists, or reject/no-op with a clear
//     "unavailable in the browser build" message.

import {
  cloudArtifactIdFromFilePath,
  cloudSessionViewToSessionView,
  type AgentCatalog,
  type AppMetadata,
  type ArtifactIndexPayload,
  type AuthState,
  type CloudProjectSnapshotInventory,
  type CloudProjectSnapshotUploadResult,
  type CloudProjectSourcePolicyVerdict,
  type CoordinationBoardPayload,
  type CoordinationProject,
  type CoordinationTask,
  type CoordinationWatch,
  type CoworkAPI,
  type DesktopPairingAuditEvent,
  type DesktopPairingCreated,
  type DesktopPairingPublicRecord,
  type DesktopPairingStatusSnapshot,
  type DestructiveConfirmationGrant,
  type EffectiveAppSettings,
  type KnowledgePageVersion,
  type KnowledgeProposal,
  type KnowledgeSnapshotPayload,
  type KnowledgeSpace,
  type LaunchpadFeedPayload,
  type ModelInfoSnapshot,
  type ProviderAuthMethod,
  type PublicAppConfig,
  type RuntimeLoadingStatus,
  type RuntimeStatus,
  type SessionArtifact,
  type SessionArtifactAttachment,
  type SessionInfo,
  type SessionView,
  type ThreadFacetSummary,
  type ThreadSearchResult,
  type UpdateInstallStatus,
  type WorkflowDetail,
  type WorkflowListPayload,
  type WorkflowRun,
  type WorkspaceApiSupport,
  type WorkspaceInfo,
} from '@open-cowork/shared'
import { createBrowserAdminApi } from './cowork-api-admin'
import { createBrowserCustomApi } from './cowork-api-custom'
import {
  browserCloudWorkspaceSupport,
  type CloudFeatureFlags,
} from './cowork-api-support'
import { createBrowserChannelsApi } from './cowork-api-channels'

import {
  base64ToBytes,
  browserUnavailable,
  cloudViewToSessionInfo,
  createTransport,
  CloudEventHub,
  readBootstrapFromWindow,
  unwrap,
  type BrowserCoworkApiBootstrap,
  type PresignedUploadBegin,
} from './cowork-api-transport'
export type { BrowserCoworkApiBootstrap } from './cowork-api-transport'
export { createTransport } from './cowork-api-transport'
export { createCloudTranscriptProjector, type CloudTranscriptProjector } from './cowork-api-transcript'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrowserCoworkApi(bootstrap?: BrowserCoworkApiBootstrap): CoworkAPI {
  const resolvedBootstrap = bootstrap || readBootstrapFromWindow() || {}
  const authRequired = resolvedBootstrap.authRequired === true
  let authenticated: boolean | null = null
  const transport = createTransport(resolvedBootstrap)
  const { request, endpoint, withQuery } = transport
  const hub = new CloudEventHub(transport)

  const channels = createBrowserChannelsApi({ request, endpoint, withQuery })

  return {
    // -- workspace ---------------------------------------------------------
    workspace: {
      list: async () => {
        // The cloud serves a single signed-in workspace; the renderer expects
        // an array of WorkspaceInfo. Map the cloud /api/workspace record.
        const raw = await request<Record<string, unknown>>(endpoint('workspace'))
        const id = typeof raw?.workspaceId === 'string' ? raw.workspaceId : typeof raw?.id === 'string' ? raw.id : 'cloud'
        const info: WorkspaceInfo = {
          id,
          kind: 'cloud',
          authority: 'cloud_worker',
          label: typeof raw?.label === 'string' ? raw.label : typeof raw?.tenantName === 'string' ? raw.tenantName : 'Cloud',
          status: 'online',
          active: true,
          tenantId: typeof raw?.tenantId === 'string' ? raw.tenantId : undefined,
          profileName: typeof raw?.profileName === 'string' ? raw.profileName : undefined,
        }
        return [info]
      },
      activate: async (workspaceId) => {
        const list = await request<Record<string, unknown>>(endpoint('workspace'))
        return {
          id: workspaceId,
          kind: 'cloud',
          authority: 'cloud_worker',
          label: typeof list?.label === 'string' ? list.label : 'Cloud',
          status: 'online',
          active: true,
        }
      },
      addCloud: () => browserUnavailable('workspace.addCloud'),
      addGateway: () => browserUnavailable('workspace.addGateway'),
      remove: () => browserUnavailable('workspace.remove'),
      login: () => browserUnavailable('workspace.login'),
      logout: () => browserUnavailable('workspace.logout'),
      policy: async () => {
        const config = await request<{ features?: Record<string, boolean> }>(endpoint('config'))
        return {
          features: config?.features || {},
          allowedAgents: null,
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        }
      },
      support: async (): Promise<WorkspaceApiSupport[]> => {
        const config = await request<{ features?: CloudFeatureFlags }>(endpoint('config'))
        return browserCloudWorkspaceSupport(config?.features || {})
      },
      sync: async () => ({ ok: true, syncedAt: new Date().toISOString() }),
    },

    // -- desktopPairing (Electron-only; no cloud equivalent) ---------------
    desktopPairing: {
      list: async (): Promise<DesktopPairingPublicRecord[]> => browserUnavailable('desktopPairing.list'),
      create: (): Promise<DesktopPairingCreated> => browserUnavailable('desktopPairing.create'),
      update: (): Promise<DesktopPairingPublicRecord> => browserUnavailable('desktopPairing.update'),
      connect: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.connect'),
      disconnect: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.disconnect'),
      revoke: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.revoke'),
      sync: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.sync'),
      audit: async (): Promise<DesktopPairingAuditEvent[]> => browserUnavailable('desktopPairing.audit'),
    },

    // -- auth --------------------------------------------------------------
    auth: {
      status: async (): Promise<AuthState> => {
        try {
          const me = await request<{ principal?: { email?: string | null } }>(endpoint('authMe'))
          const email = me?.principal?.email || null
          authenticated = Boolean(me?.principal)
          return { authenticated, email }
        } catch (error) {
          if ((error as { status?: unknown } | null)?.status !== 401) throw error
          authenticated = false
          return { authenticated: false, email: null }
        }
      },
      login: async (): Promise<AuthState> => {
        // Browser auth is a full-page redirect to the cloud OIDC login.
        if (typeof window !== 'undefined') window.location.assign('/auth/login')
        return { authenticated: false, email: null }
      },
      logout: async (): Promise<AuthState> => {
        try {
          await request(endpoint('authLogout'), { method: 'POST', body: {} })
        } catch {
          // Best-effort; clear local state regardless.
        }
        for (const listener of hub.listeners.authLogout) listener()
        return { authenticated: false, email: null }
      },
    },

    // -- session -----------------------------------------------------------
    session: {
      create: async (_directory, options) => {
        const created = await request<unknown>(endpoint('sessions'), {
          method: 'POST',
          body: { profileName: null, projectSource: options?.projectSource ?? null },
        })
        const info = cloudViewToSessionInfo(created)
        if (info.id) hub.trackSession(info.id)
        return info
      },
      activate: async (sessionId): Promise<SessionView> => {
        hub.trackSession(sessionId)
        const envelope = await request<unknown>(endpoint('sessionView', { sessionId }))
        const view = unwrap<SessionView | undefined>(envelope, 'view', undefined)
        if (view) return view
        // Fall back to projecting the cloud view envelope locally.
        return cloudSessionViewToSessionView(envelope as Parameters<typeof cloudSessionViewToSessionView>[0])
      },
      prompt: async (sessionId, text, _attachments, agent) => {
        await request(endpoint('sessionPrompt', { sessionId }), { method: 'POST', body: { text, agent } })
      },
      setComposerPreferences: async () => null,
      list: async (): Promise<SessionInfo[]> => {
        const page = await request<{ sessions?: unknown[] }>(endpoint('sessions'))
        const sessions = Array.isArray(page?.sessions) ? page.sessions : []
        return sessions.map(cloudViewToSessionInfo)
      },
      get: async (id): Promise<SessionInfo | null> => {
        try {
          const view = await request<unknown>(endpoint('sessionView', { sessionId: id }))
          return cloudViewToSessionInfo(view)
        } catch {
          return null
        }
      },
      importInventory: () => browserUnavailable('session.importInventory'),
      copyToCloud: () => browserUnavailable('session.copyToCloud'),
      abort: async (sessionId) => {
        await request(endpoint('sessionAbort', { sessionId }), { method: 'POST', body: {} })
      },
      abortTask: () => browserUnavailable('session.abortTask'),
      rename: () => browserUnavailable('session.rename'),
      delete: () => browserUnavailable('session.delete'),
      export: async () => null,
      fork: async () => null,
      share: async () => null,
      unshare: () => browserUnavailable('session.unshare'),
      summarize: async () => ({ ok: false as const, message: 'Summaries are not available in the browser build.' }),
      revert: () => browserUnavailable('session.revert'),
      unrevert: () => browserUnavailable('session.unrevert'),
      children: async () => [],
      diff: async () => [],
      fileSnippet: async () => [],
      todo: async () => [],
    },

    // -- projectSource -----------------------------------------------------
    projectSource: {
      validate: (input) =>
        request<CloudProjectSourcePolicyVerdict>(endpoint('projectSourceValidate'), { method: 'POST', body: input }),
      snapshotInventory: (): Promise<CloudProjectSnapshotInventory> => browserUnavailable('projectSource.snapshotInventory'),
      uploadSnapshot: (): Promise<CloudProjectSnapshotUploadResult> => browserUnavailable('projectSource.uploadSnapshot'),
    },

    // -- coordination ------------------------------------------------------
    coordination: {
      board: (options) =>
        request<CoordinationBoardPayload>(withQuery(endpoint('coordinationBoard'), {
          workspaceId: options?.workspaceId,
          projectId: options?.projectId,
          limit: options?.limit,
        })),
      listProjects: (options) =>
        request<CoordinationProject[]>(withQuery(endpoint('coordinationProjects'), { workspaceId: options?.workspaceId, limit: 100 })),
      createProject: (input) => request<CoordinationProject>(endpoint('coordinationProjectCreate'), { method: 'POST', body: input }),
      updateProject: (projectId, input) =>
        request<CoordinationProject | null>(endpoint('coordinationProject', { projectId }), { method: 'POST', body: input }),
      planWithCleo: (projectId, input) =>
        request(endpoint('coordinationPlanWithCleo', { projectId }), { method: 'POST', body: input || {} }),
      listTasks: (options) =>
        request<CoordinationTask[]>(withQuery(endpoint('coordinationTasks'), {
          workspaceId: options?.workspaceId,
          projectId: options?.projectId,
          limit: options?.limit ?? 500,
        })),
      createTask: (input) => request<CoordinationTask>(endpoint('coordinationTaskCreate'), { method: 'POST', body: input }),
      updateTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTask', { taskId }), { method: 'POST', body: input }),
      moveTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskMove', { taskId }), { method: 'POST', body: input }),
      assignTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskAssign', { taskId }), { method: 'POST', body: input }),
      linkTaskWork: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskLinkWork', { taskId }), { method: 'POST', body: input }),
      taskWorkTarget: (taskId, options) =>
        request<SessionInfo | null>(withQuery(endpoint('coordinationTaskWorkTarget', { taskId }), { workspaceId: options?.workspaceId })),
      listWatches: (options) =>
        request<CoordinationWatch[]>(withQuery(endpoint('coordinationWatches'), {
          workspaceId: options?.workspaceId,
          targetKind: options?.targetKind,
          targetId: options?.targetId,
          status: options?.status,
          limit: options?.limit ?? 500,
        })),
      createWatch: (input) => request<CoordinationWatch>(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request<CoordinationWatch | null>(endpoint('coordinationWatch', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchPause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchResume', { watchId }), { method: 'POST' }),
      deleteWatch: async (watchId) =>
        Boolean(unwrap(await request(endpoint('coordinationWatchDelete', { watchId }), { method: 'DELETE' }), 'deleted', true)),
    },

    // -- channels ----------------------------------------------------------
    channels,

    // -- launchpad ---------------------------------------------------------
    launchpad: {
      feed: (req) =>
        request<LaunchpadFeedPayload>(withQuery(endpoint('launchpadFeed'), { workspaceId: req?.workspaceId })),
    },

    // -- knowledge ---------------------------------------------------------
    knowledge: {
      snapshot: (options) =>
        request<KnowledgeSnapshotPayload>(withQuery(endpoint('knowledgeSnapshot'), {
          workspaceId: options?.workspaceId,
          spaceId: options?.spaceId,
          limit: options?.limit,
        })),
      createSpace: (input) => request<KnowledgeSpace>(endpoint('knowledgeSpaceCreate'), { method: 'POST', body: input }),
      propose: (input) => request<KnowledgeProposal>(endpoint('knowledgeProposalCreate'), { method: 'POST', body: input }),
      acceptProposal: (proposalId, input) =>
        request<{ proposal: KnowledgeProposal; page: KnowledgePageVersion }>(endpoint('knowledgeProposalAccept', { proposalId }), { method: 'POST', body: input || {} }),
      declineProposal: (proposalId, input) =>
        request<KnowledgeProposal>(endpoint('knowledgeProposalDecline', { proposalId }), { method: 'POST', body: input || {} }),
      history: (pageId, options) =>
        request<KnowledgePageVersion[]>(withQuery(endpoint('knowledgePageHistory', { pageId }), {
          workspaceId: options?.workspaceId,
          spaceId: options?.spaceId,
          limit: options?.limit,
        })),
      restoreVersion: (pageId, versionId, input) =>
        request<{ page: KnowledgePageVersion }>(endpoint('knowledgePageRestore', { pageId }), { method: 'POST', body: { ...(input || {}), versionId } }),
    },

    // -- permission --------------------------------------------------------
    permission: {
      respond: async (id, allowed, sessionId) => {
        if (!sessionId) return
        await request(endpoint('sessionPermissionRespond', { sessionId }), {
          method: 'POST',
          body: { permissionId: id, response: { allowed } },
        })
      },
    },

    // -- question ----------------------------------------------------------
    question: {
      reply: async (sessionId, requestId, answers) => {
        await request(endpoint('sessionQuestionReply', { sessionId }), { method: 'POST', body: { requestId, answers } })
      },
      reject: async (sessionId, requestId) => {
        await request(endpoint('sessionQuestionReject', { sessionId }), { method: 'POST', body: { requestId } })
      },
    },

    // -- settings ----------------------------------------------------------
    settings: {
      get: async (): Promise<EffectiveAppSettings> => {
        const raw = await request<Partial<EffectiveAppSettings>>(endpoint('settings'))
        return (raw || {}) as EffectiveAppSettings
      },
      getProviderCredentials: async () => ({}),
      getIntegrationCredentials: async () => ({}),
      set: async (updates): Promise<EffectiveAppSettings> => {
        const raw = await request<Partial<EffectiveAppSettings>>(endpoint('settings'), { method: 'PUT', body: updates })
        return (raw || {}) as EffectiveAppSettings
      },
    },

    // -- mcp (read/connect; cloud has no per-MCP control surface) ----------
    mcp: {
      auth: async () => browserUnavailable('mcp.auth'),
      connect: async () => browserUnavailable('mcp.connect'),
      disconnect: async () => browserUnavailable('mcp.disconnect'),
      preflight: () => browserUnavailable('mcp.preflight'),
    },

    // -- dialog (Electron-only native pickers) -----------------------------
    dialog: {
      selectDirectory: async () => null,
      selectImage: async () => null,
      openJson: async () => null,
      saveText: async () => null,
    },

    // -- chart -------------------------------------------------------------
    chart: {
      renderSvg: () => browserUnavailable('chart.renderSvg'),
      saveArtifact: (): Promise<SessionArtifact> => browserUnavailable('chart.saveArtifact'),
    },

    // -- artifact ----------------------------------------------------------
    artifact: {
      list: async (req): Promise<SessionArtifact[]> =>
        unwrap(await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { limit: 100 })), 'artifacts', []),
      index: (req) =>
        request<ArtifactIndexPayload>(withQuery(endpoint('artifactsIndex'), { workspaceId: req?.workspaceId })),
      updateStatus: async (req): Promise<SessionArtifact> =>
        unwrap(
          await request(endpoint('sessionArtifactStatus', { sessionId: req.sessionId, artifactId: req.artifactId }), { method: 'POST', body: req }),
          'artifact',
          null as never,
        ),
      upload: async (req): Promise<SessionArtifact> => {
        // Buffered upload: base64 the whole artifact through the cloud API. This is the
        // default-safe path and the unchanged behaviour the renderer has always seen.
        const bufferedUpload = async (): Promise<SessionArtifact> =>
          unwrap(await request(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { method: 'POST', body: req }), 'artifact', null as never)

        // Cloud/browser optimization: when the server advertises presigned upload support, push
        // the bytes straight to object storage (begin -> direct PUT -> finalize) so they never
        // base64-buffer through the web pod. A begin failure is a real API failure and must remain
        // visible; buffered fallback is reserved for an explicit unsupported response or a failed
        // object-store PUT. (Electron implements `upload` over IPC and never reaches this code.)
        const begun = unwrap<PresignedUploadBegin | null>(
          await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { transfer: 'presigned' }), {
            method: 'POST',
            body: { filename: req.filename, contentType: req.contentType ?? null },
          }),
          'upload',
          null,
        )
        if (!begun || begun.transfer !== 'presigned' || !begun.uploadUrl || !begun.artifactId) {
          return bufferedUpload()
        }

        let putOk: boolean
        try {
          const putResponse = await fetch(begun.uploadUrl, {
            method: begun.uploadMethod || 'PUT',
            headers: begun.uploadHeaders || {},
            // Uint8Array is a valid runtime BodyInit; the cast bridges the typed-array generics
            // friction in the DOM lib's BufferSource definition.
            body: base64ToBytes(req.dataBase64) as unknown as BodyInit,
          })
          putOk = putResponse.ok
        } catch {
          putOk = false
        }
        if (!putOk) return bufferedUpload()

        // The bytes are in the store; record the metadata row. Finalize errors propagate (a
        // buffered retry here would re-upload the bytes under a second artifact id).
        return unwrap(
          await request(endpoint('sessionArtifactFinalize', { sessionId: req.sessionId, artifactId: begun.artifactId }), {
            method: 'POST',
            body: {
              filename: req.filename,
              contentType: req.contentType ?? null,
              kind: req.kind ?? null,
              status: req.status ?? null,
              authorAgentId: req.authorAgentId ?? null,
              projectId: req.projectId ?? null,
              taskId: req.taskId ?? null,
              statusUpdatedBy: req.statusUpdatedBy ?? null,
              statusUpdatedAt: req.statusUpdatedAt ?? null,
            },
          }),
          'artifact',
          null as never,
        )
      },
      open: async () => null,
      export: async () => null,
      reveal: async () => false,
      readAttachment: async (req): Promise<SessionArtifactAttachment> => {
        // The renderer addresses cloud artifacts by their synthetic file path
        // (see cloudArtifactFilePath); recover the artifactId and resolve the
        // cloud artifact body, then shape it as a SessionArtifactAttachment.
        const artifactId = cloudArtifactIdFromFilePath(req.filePath) || req.filePath
        const envelope = await request<{ artifact?: Record<string, unknown> }>(
          endpoint('sessionArtifact', { sessionId: req.sessionId, artifactId }),
        )
        const artifact = (envelope?.artifact || {}) as Record<string, unknown>
        const mime = typeof artifact.contentType === 'string' && artifact.contentType ? artifact.contentType : 'application/octet-stream'
        const dataBase64 = typeof artifact.dataBase64 === 'string' ? artifact.dataBase64 : ''
        const filename = typeof artifact.filename === 'string' ? artifact.filename : 'artifact'
        return {
          mime,
          url: dataBase64 ? `data:${mime};base64,${dataBase64}` : '',
          filename,
          chart: null,
        }
      },
      storageStats: () => browserUnavailable('artifact.storageStats'),
      cleanup: () => browserUnavailable('artifact.cleanup'),
    },

    // -- confirm (no native dialog; grant a short-lived local token) -------
    confirm: {
      requestDestructive: async (): Promise<DestructiveConfirmationGrant | null> => null,
    },

    // -- clipboard (browser primitive) ------------------------------------
    clipboard: {
      writeText: async (text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch {
          // Fall through to failure.
        }
        return false
      },
    },

    // -- model (no cloud route; empty pricing snapshot) --------------------
    model: {
      info: async (): Promise<ModelInfoSnapshot> => ({ pricing: {}, contextLimits: {} }),
    },

    // -- tools (no cloud route) -------------------------------------------
    tools: {
      list: async () => [],
    },

    // -- command (no cloud route) -----------------------------------------
    command: {
      list: async () => [],
      run: () => browserUnavailable('command.run'),
    },

    // -- provider (read via config; authorize/callback are local OAuth) ----
    provider: {
      list: async () => {
        const config = await request<{ providers?: { available?: unknown[] } }>(endpoint('config'))
        const available = Array.isArray(config?.providers?.available) ? config.providers.available : []
        return available.map((entry) => {
          const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
          return {
            id: typeof record.id === 'string' ? record.id : undefined,
            name: typeof record.name === 'string' ? record.name : undefined,
            connected: typeof record.connected === 'boolean' ? record.connected : undefined,
          }
        })
      },
      authMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({}),
      testConnection: async (providerId, modelId) => ({ ok: false, providerId, modelId }),
      authorize: () => browserUnavailable('provider.authorize'),
      callback: () => browserUnavailable('provider.callback'),
      logout: () => browserUnavailable('provider.logout'),
    },

    // -- runtime (status from cloud; restart/await are Electron-only) ------
    runtime: {
      status: async (): Promise<RuntimeStatus> => {
        const raw = await request<Partial<RuntimeStatus>>(endpoint('runtimeStatus'))
        return { ready: Boolean(raw?.ready), error: raw?.error ?? null, ...raw }
      },
      awaitInitialization: async (): Promise<RuntimeLoadingStatus> => ({
        phase: 'ready',
        message: '',
        ready: true,
        error: null,
        updatedAt: new Date().toISOString(),
      }),
      restart: () => browserUnavailable('runtime.restart'),
    },

    // -- projects (no cloud route; recent-project navigation is local) -----
    projects: {
      list: async () => [],
      switchByIndex: async () => null,
    },

    // -- diagnostics -------------------------------------------------------
    diagnostics: {
      perf: () => browserUnavailable('diagnostics.perf'),
      reportRendererError: () => {
        // Fire-and-forget; the browser build relies on platform error reporting.
      },
    },

    // -- app ---------------------------------------------------------------
    app: {
      metadata: async (): Promise<AppMetadata> => ({ version: '0.0.0', preview: false, surface: 'browser' }),
      // The cloud /api/config returns a different shape than the renderer's
      // PublicAppConfig; default every required field (the renderer hard-reads
      // config.auth.enabled) and let the cloud response override what it provides.
      config: async (): Promise<PublicAppConfig> => {
        // Once /auth/me has established that this browser is signed out, do not
        // probe the protected config endpoint as a second failed auth attempt.
        // That avoids needless auth-backoff/rate-limit pressure during boot.
        const raw = authRequired && authenticated === false
          ? {} as Record<string, unknown>
          : await request<Record<string, unknown>>(endpoint('config')).catch((error: unknown) => {
              // Direct callers may ask for config before auth.status(). Preserve
              // the same fail-closed login state for that ordering, but surface
              // every non-auth failure as a real boot error.
              if (authRequired && (error as { status?: unknown } | null)?.status === 401) {
                authenticated = false
                return {} as Record<string, unknown>
              }
              throw error
            })
        const merged: Record<string, unknown> = {
          branding: { name: 'Open Cowork' },
          providers: { available: [], defaultProvider: null, defaultModel: null },
          permissions: { bash: 'ask', fileWrite: 'ask', task: 'ask', web: 'ask', webSearch: false },
          agentStarterTemplates: [],
          ...raw,
          auth: authRequired
            ? { mode: 'google-oauth', enabled: true }
            : (raw.auth as PublicAppConfig['auth'] | undefined) ?? { mode: 'none', enabled: false },
        }
        return merged as unknown as PublicAppConfig
      },
      builtinAgents: async () => [],
      runtimeInputs: () => browserUnavailable('app.runtimeInputs'),
      refreshProviderCatalog: async () => [],
      exportDiagnostics: async () => {
        try {
          return JSON.stringify(await request(endpoint('diagnostics')))
        } catch {
          return null
        }
      },
      checkUpdates: async () => ({ status: 'disabled', currentVersion: '0.0.0', message: 'Updates are managed by the browser deployment.' }),
      reset: () => browserUnavailable('app.reset'),
    },

    // -- updates (Electron-only auto-updater) ------------------------------
    updates: {
      installCapability: async () => ({
        supported: false,
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
        releaseSource: null,
      }),
      checkInstallable: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      download: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      quitAndInstall: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      onInstallEvent: () => () => {},
    },

    // -- workflows ---------------------------------------------------------
    workflows: {
      list: () => request<WorkflowListPayload>(endpoint('workflows')),
      get: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflow', { workflowId })), 'workflow', null),
      startDraft: () => browserUnavailable('workflows.startDraft'),
      runNow: async (workflowId): Promise<WorkflowRun | null> =>
        unwrap(await request(endpoint('workflowRun', { workflowId }), { method: 'POST', body: {} }), 'run', null),
      pause: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowPause', { workflowId }), { method: 'POST' }), 'workflow', null),
      resume: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowResume', { workflowId }), { method: 'POST' }), 'workflow', null),
      archive: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowArchive', { workflowId }), { method: 'POST' }), 'workflow', null),
      regenerateWebhookSecret: () => browserUnavailable('workflows.regenerateWebhookSecret'),
    },

    // -- threads -----------------------------------------------------------
    threads: {
      search: (query) =>
        request<ThreadSearchResult>(endpoint('threadsSearch'), { method: 'POST', body: query || {} }),
      facets: (query) =>
        request<ThreadFacetSummary>(endpoint('threadsFacets'), { method: 'POST', body: query || {} }),
      tags: {
        list: async () => [],
        create: () => browserUnavailable('threads.tags.create'),
        update: () => browserUnavailable('threads.tags.update'),
        delete: () => browserUnavailable('threads.tags.delete'),
        apply: () => browserUnavailable('threads.tags.apply'),
        remove: () => browserUnavailable('threads.tags.remove'),
      },
      smartFilters: {
        list: async () => [],
        create: () => browserUnavailable('threads.smartFilters.create'),
        update: () => browserUnavailable('threads.smartFilters.update'),
        delete: () => browserUnavailable('threads.smartFilters.delete'),
      },
      suggestions: {
        accept: () => browserUnavailable('threads.suggestions.accept'),
        edit: () => browserUnavailable('threads.suggestions.edit'),
        dismiss: () => browserUnavailable('threads.suggestions.dismiss'),
      },
      reindex: async () => false,
    },
    admin: createBrowserAdminApi(request), // admin control plane (#896)
    agents: {
      catalog: async (): Promise<AgentCatalog> => {
        const catalog = await request<Partial<AgentCatalog>>(endpoint('capabilitiesCatalog'))
        return {
          tools: Array.isArray(catalog?.tools) ? catalog.tools : [],
          skills: Array.isArray(catalog?.skills) ? catalog.skills : [],
          reservedNames: Array.isArray(catalog?.reservedNames) ? catalog.reservedNames : [],
          colors: Array.isArray(catalog?.colors) ? catalog.colors : [],
        }
      },
      list: async () => [],
      runtime: async () => [],
      create: () => browserUnavailable('agents.create'),
      update: () => browserUnavailable('agents.update'),
      remove: () => browserUnavailable('agents.remove'),
    },

    // -- capabilities ------------------------------------------------------
    capabilities: {
      tools: async (options) =>
        unwrap(await request(withQuery(endpoint('capabilityTools'), { workspaceId: options?.workspaceId })), 'tools', []),
      tool: async (id, options) =>
        unwrap(await request(withQuery(endpoint('capabilityTool', { toolId: id }), { workspaceId: options?.workspaceId })), 'tool', null),
      skills: async (options) =>
        unwrap(await request(withQuery(endpoint('capabilitySkills'), { workspaceId: options?.workspaceId })), 'skills', []),
      skillBundle: async (skillName, options) =>
        unwrap(await request(withQuery(endpoint('capabilitySkillBundle', { skillName }), { workspaceId: options?.workspaceId })), 'bundle', null),
      skillBundleFile: async () => null,
    },

    // -- explorer (local filesystem; not available in the browser) ---------
    explorer: {
      fileList: async () => [],
      fileRead: async () => null,
      fileStatus: async () => [],
      findFiles: async () => [],
      findSymbols: async () => [],
      findText: async () => [],
    },

    // -- custom (local FS imports + custom content mutations) --------------
    custom: createBrowserCustomApi(),

    // -- on.* (SSE demux) --------------------------------------------------
    on: {
      sessionPatch: (callback) => hub.subscribe('sessionPatch', callback),
      notification: (callback) => hub.subscribe('notification', callback),
      sessionView: (callback) => hub.subscribe('sessionView', callback),
      permissionRequest: (callback) => hub.subscribe('permissionRequest', callback),
      mcpStatus: (callback) => hub.subscribe('mcpStatus', callback),
      authExpired: (callback) => hub.subscribe('authExpired', callback),
      authLogout: (callback) => hub.subscribe('authLogout', callback),
      menuAction: (callback) => hub.subscribe('menuAction', callback),
      menuNavigate: (callback) => hub.subscribe('menuNavigate', callback),
      runtimeReady: (callback) => hub.subscribe('runtimeReady', callback),
      runtimeLoadingStatus: (callback) => hub.subscribe('runtimeLoadingStatus', callback),
      sessionUpdated: (callback) => hub.subscribe('sessionUpdated', callback),
      sessionDeleted: (callback) => hub.subscribe('sessionDeleted', callback),
      workspaceSessionsUpdated: (callback) => hub.subscribe('workspaceSessionsUpdated', callback),
      workflowUpdated: (callback) => hub.subscribe('workflowUpdated', callback),
      coordinationUpdated: (callback) => hub.subscribe('coordinationUpdated', callback),
      knowledgeUpdated: (callback) => hub.subscribe('knowledgeUpdated', callback),
    },
  }
}
