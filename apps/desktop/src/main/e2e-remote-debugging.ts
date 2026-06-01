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
  waitingReason?: string
  surface?: Record<string, string>
  settings?: Record<string, unknown>
  installCapability?: Record<string, unknown>
  sessions?: Array<{ id: string }>
  createdSessionId?: string | null
}
type E2EProbeFile = {
  ok: boolean
  result?: E2EProbeResult
  error?: string
  writtenAt: string
}

const WINDOWS_ROOTED_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/])/
const E2E_ENV_ARG_PREFIX = '--open-cowork-e2e-env='
export const E2E_ARG_ENV_ENABLE_KEY = 'OPEN_COWORK_E2E_ARG_ENV'
export const E2E_ALLOW_SETTINGS_MUTATION_KEY = 'OPEN_COWORK_E2E_ALLOW_SETTINGS_MUTATION'
const E2E_ARG_ENV_KEYS = new Set([
  'OPEN_COWORK_CHART_TIMEOUT_MS',
  'OPEN_COWORK_CONFIG_PATH',
  E2E_ARG_ENV_ENABLE_KEY,
  E2E_ALLOW_SETTINGS_MUTATION_KEY,
  'HOME',
  'TMPDIR',
  'OPEN_COWORK_E2E',
  'OPEN_COWORK_E2E_PROBE_ACTION',
  'OPEN_COWORK_E2E_READY_FILE',
  'OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT',
  'OPEN_COWORK_SANDBOX_DIR',
  'OPEN_COWORK_USER_DATA_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
])

export function e2eReadyFileRelativePathIsContained(relativeToTmp: string) {
  if (!relativeToTmp || relativeToTmp.startsWith('..')) return false
  if (isAbsolute(relativeToTmp)) return false
  return !WINDOWS_ROOTED_PATH_RE.test(relativeToTmp)
}

export function buildE2EArgEnvironment(env: Record<string, string>) {
  return Object.entries(env)
    .filter(([key]) => E2E_ARG_ENV_KEYS.has(key))
    .map(([key, value]) => `${E2E_ENV_ARG_PREFIX}${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
}

function e2eArgEnvironmentIsEnabled(argv: readonly string[], env: NodeJS.ProcessEnv) {
  if (env[E2E_ARG_ENV_ENABLE_KEY] === '1') return true
  for (const arg of argv) {
    if (!arg.startsWith(E2E_ENV_ARG_PREFIX)) continue
    const encoded = arg.slice(E2E_ENV_ARG_PREFIX.length)
    const separatorIndex = encoded.indexOf('=')
    if (separatorIndex <= 0) continue
    try {
      const key = decodeURIComponent(encoded.slice(0, separatorIndex))
      const value = decodeURIComponent(encoded.slice(separatorIndex + 1))
      if (key === E2E_ARG_ENV_ENABLE_KEY && value === '1') return true
    } catch {
      continue
    }
  }
  return false
}

export function applyE2EArgEnvironment(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env) {
  if (!e2eArgEnvironmentIsEnabled(argv, env)) return
  const appliedKeys = new Set<string>()
  for (const arg of argv) {
    if (!arg.startsWith(E2E_ENV_ARG_PREFIX)) continue
    const encoded = arg.slice(E2E_ENV_ARG_PREFIX.length)
    const separatorIndex = encoded.indexOf('=')
    if (separatorIndex <= 0) continue
    let key: string
    let value: string
    try {
      key = decodeURIComponent(encoded.slice(0, separatorIndex))
      value = decodeURIComponent(encoded.slice(separatorIndex + 1))
    } catch {
      continue
    }
    if (!E2E_ARG_ENV_KEYS.has(key)) continue
    if (appliedKeys.has(key)) continue
    env[key] = value
    appliedKeys.add(key)
  }
}

function writeE2EProbeFile(target: string, payload: Omit<E2EProbeFile, 'writtenAt'>) {
  writeFileAtomic(target, JSON.stringify({ ...payload, writtenAt: new Date().toISOString() }), { mode: 0o600 })
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

export function e2eWindowReadyProbeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(resolveE2EReadyFile(env))
}

export function e2eSettingsMutationAllowed(
  env: NodeJS.ProcessEnv = process.env,
  options: { isPackaged?: boolean } = {},
) {
  if (env.OPEN_COWORK_E2E !== '1') return false
  return options.isPackaged === true
    ? env[E2E_ALLOW_SETTINGS_MUTATION_KEY] === '1'
    : true
}

export async function writeE2EWindowReadyProbe(
  webContents: WebContentsProbe,
  env: NodeJS.ProcessEnv = process.env,
  options: { isPackaged?: boolean } = {},
) {
  const target = resolveE2EReadyFile(env)
  if (!target) return false
  const action = env.OPEN_COWORK_E2E_PROBE_ACTION === 'create-session'
    || env.OPEN_COWORK_E2E_PROBE_ACTION === 'list-sessions'
    ? env.OPEN_COWORK_E2E_PROBE_ACTION
    : 'surface'
  const allowSettingsMutation = e2eSettingsMutationAllowed(env, options)
  try {
    const result = await webContents.executeJavaScript<E2EProbeResult>(`
    (async () => {
      const api = window.coworkApi || {};
      if (typeof api.settings?.get !== 'function' || typeof api.updates?.installCapability !== 'function') {
        return { waiting: true, waitingReason: 'preload-api-unavailable' };
      }
      const delay = (ms) => new Promise((done) => setTimeout(done, ms));
      const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        delay(ms).then(() => {
          throw new Error(label + ' timed out after ' + ms + 'ms');
        }),
      ]);
      const setupComplete = async () => {
        const [config, settings] = await Promise.all([
          api.app.config(),
          api.settings.get(),
        ]);
        if (!settings.effectiveProviderId || !settings.effectiveModel) return false;
        const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId);
        if (!provider) return false;
        const providerCredentials = await api.settings.getProviderCredentials(provider.id, {
          workspaceId: 'local',
          purpose: 'credential_editor',
        });
        return provider.credentials.every((credential) => {
          if (credential.required === false) return true;
          const value = providerCredentials[credential.key];
          return typeof value === 'string' && value.trim().length > 0;
        });
      };
      if (!(await setupComplete())) {
        if (!${JSON.stringify(allowSettingsMutation)}) {
          return { waiting: true, waitingReason: 'setup-incomplete-settings-mutation-disabled' };
        }
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
      const initialSessions = await api.session.list();
      const initialIds = initialSessions.map((session) => session.id);
      let sessions = initialSessions;
      let createdSessionId = null;
      if (action === 'create-session') {
        await withTimeout((async () => {
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            const status = await api.runtime?.status?.().catch(() => null);
            if (status?.ready) return;
            await delay(250);
          }
          throw new Error('Runtime readiness timed out after 60000ms');
        })(), 65000, 'Waiting for packaged smoke runtime readiness');
        await withTimeout(api.session.create(null), 30000, 'Creating packaged smoke session');
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
    if (result?.reloading) return true
    if (result?.waiting) {
      writeE2EProbeFile(target, {
        ok: false,
        error: `E2E ready probe waiting: ${result.waitingReason || 'unknown'}`,
      })
      return true
    }
    writeE2EProbeFile(target, { ok: true, result })
    return true
  } catch (error) {
    writeE2EProbeFile(target, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
