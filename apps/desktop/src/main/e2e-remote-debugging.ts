import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { writeFileAtomic } from './fs-atomic.ts'

type ElectronAppWithCommandLine = {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
}
type WebContentsProbe = {
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
}
type E2EProbeResult = {
  reloading?: boolean
  waiting?: boolean
  surface?: Record<string, string>
  settings?: Record<string, unknown>
  installCapability?: Record<string, unknown>
  sessions?: Array<{ id: string }>
  createdSessionId?: string | null
}

const WINDOWS_ROOTED_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/])/

export function e2eReadyFileRelativePathIsContained(relativeToTmp: string) {
  if (!relativeToTmp || relativeToTmp.startsWith('..')) return false
  if (isAbsolute(relativeToTmp)) return false
  return !WINDOWS_ROOTED_PATH_RE.test(relativeToTmp)
}

export function resolveE2ERemoteDebuggingPort(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPEN_COWORK_E2E !== '1') return null
  const raw = env.OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT?.trim()
  if (!raw || !/^\d{1,5}$/.test(raw)) return null
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return String(port)
}

export function appendE2ERemoteDebuggingSwitches(electronApp: ElectronAppWithCommandLine, env: NodeJS.ProcessEnv = process.env) {
  const port = resolveE2ERemoteDebuggingPort(env)
  if (!port) return false
  electronApp.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  electronApp.commandLine.appendSwitch('remote-debugging-port', port)
  return true
}

function resolveE2EReadyFile(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPEN_COWORK_E2E !== '1') return null
  const raw = env.OPEN_COWORK_E2E_READY_FILE?.trim()
  if (!raw) return null
  const target = resolve(raw)
  const tmpRoot = resolve(env.TMPDIR || tmpdir())
  const relativeToTmp = relative(tmpRoot, target)
  if (!e2eReadyFileRelativePathIsContained(relativeToTmp)) return null
  return target
}

export async function writeE2EWindowReadyProbe(webContents: WebContentsProbe, env: NodeJS.ProcessEnv = process.env) {
  const target = resolveE2EReadyFile(env)
  if (!target) return false
  const action = env.OPEN_COWORK_E2E_PROBE_ACTION === 'create-session'
    || env.OPEN_COWORK_E2E_PROBE_ACTION === 'list-sessions'
    ? env.OPEN_COWORK_E2E_PROBE_ACTION
    : 'surface'
  const result = await webContents.executeJavaScript<E2EProbeResult>(`
    (async () => {
      const api = window.coworkApi || {};
      if (typeof api.settings?.get !== 'function' || typeof api.updates?.installCapability !== 'function') {
        return { waiting: true };
      }
      const delay = (ms) => new Promise((done) => setTimeout(done, ms));
      const setupComplete = async () => {
        const [config, settings] = await Promise.all([
          api.app.config(),
          api.settings.get(),
        ]);
        if (!settings.effectiveProviderId || !settings.effectiveModel) return false;
        const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId);
        if (!provider) return false;
        const providerCredentials = await api.settings.getProviderCredentials(provider.id);
        return provider.credentials.every((credential) => {
          if (credential.required === false) return true;
          const value = providerCredentials[credential.key];
          return typeof value === 'string' && value.trim().length > 0;
        });
      };
      if (!(await setupComplete())) {
        await api.settings.set({
          selectedProviderId: 'openrouter',
          selectedModelId: 'anthropic/claude-sonnet-4',
          providerCredentials: {
            openrouter: { apiKey: 'placeholder-key' },
          },
        });
        setTimeout(() => window.location.reload(), 0);
        return { reloading: true };
      }
      const surface = {
        sessionCreate: typeof api.session?.create,
        settingsSet: typeof api.settings?.set,
        workflowsStartDraft: typeof api.workflows?.startDraft,
        updatesInstallCapability: typeof api.updates?.installCapability,
        onSessionPatch: typeof api.on?.sessionPatch,
      };
      const settings = await api.settings.get();
      const installCapability = await api.updates.installCapability();
      const action = ${JSON.stringify(action)};
      const waitForRuntimeReady = async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const status = await api.runtime.status().catch(() => null);
          if (status?.ready) return true;
          await delay(500);
        }
        return false;
      };
      const initialSessions = await api.session.list();
      const initialIds = initialSessions.map((session) => session.id);
      let sessions = initialSessions;
      let createdSessionId = null;
      if (action === 'create-session') {
        if (!(await waitForRuntimeReady())) {
          throw new Error('Runtime did not become ready for packaged session probe');
        }
        await api.session.create(null);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          sessions = await api.session.list();
          createdSessionId = sessions.find((session) => !initialIds.includes(session.id))?.id || null;
          if (createdSessionId) break;
          await delay(250);
        }
      } else if (action === 'list-sessions') {
        sessions = await api.session.list();
      }
      return {
        surface,
        settings: {
          effectiveProviderId: settings.effectiveProviderId,
          effectiveModel: settings.effectiveModel,
        },
        installCapability: {
          supported: installCapability.supported,
          reason: installCapability.reason,
          currentVersion: installCapability.currentVersion,
        },
        sessions: sessions.map((session) => ({ id: session.id })),
        createdSessionId,
      };
    })()
  `, false)
  if (result?.reloading || result?.waiting) return true
  writeFileAtomic(target, JSON.stringify({ ok: true, result, writtenAt: new Date().toISOString() }), { mode: 0o600 })
  return true
}
