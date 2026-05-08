import { win32 } from 'path'

import type { getRuntimeEnvPaths } from './runtime-paths.ts'
import {
  OPEN_COWORK_MANAGED_RUNTIME_ENV,
  OPEN_COWORK_MANAGED_RUNTIME_VALUE,
} from './runtime-process-cleanup.ts'

type RuntimeEnvPaths = ReturnType<typeof getRuntimeEnvPaths>

const RUNTIME_ENV_PASSTHROUGH_KEYS = new Set([
  'APPDATA',
  'ALL_PROXY',
  'COMSPEC',
  'ComSpec',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'WINDIR',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
])

function shouldPassRuntimeEnvKey(key: string) {
  return RUNTIME_ENV_PASSTHROUGH_KEYS.has(key) || key.toLowerCase() === 'path' || key.toLowerCase() === 'comspec' || key.startsWith('LC_')
}

function applyManagedHomeEnvironment(env: NodeJS.ProcessEnv, runtimePaths: RuntimeEnvPaths) {
  env.HOME = runtimePaths.home
  env.XDG_CONFIG_HOME = runtimePaths.configHome
  env.XDG_DATA_HOME = runtimePaths.dataHome
  env.XDG_CACHE_HOME = runtimePaths.cacheHome
  env.XDG_STATE_HOME = runtimePaths.stateHome
  env.USERPROFILE = runtimePaths.home
  env.APPDATA = runtimePaths.configHome
  env.LOCALAPPDATA = runtimePaths.dataHome

  const parsed = win32.parse(runtimePaths.home)
  if (/^[a-zA-Z]:\\$/.test(parsed.root)) {
    env.HOMEDRIVE = parsed.root.slice(0, 2)
    env.HOMEPATH = runtimePaths.home.slice(2) || '\\'
  } else {
    delete env.HOMEDRIVE
    delete env.HOMEPATH
  }
}

export function buildManagedRuntimeEnvironment(input: {
  currentEnv: NodeJS.ProcessEnv
  runtimePaths: RuntimeEnvPaths
  adcPath?: string | null
  enableNativeWebSearch?: boolean
}) {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input.currentEnv)) {
    if (value !== undefined && shouldPassRuntimeEnvKey(key)) env[key] = value
  }

  applyManagedHomeEnvironment(env, input.runtimePaths)
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1'
  env[OPEN_COWORK_MANAGED_RUNTIME_ENV] = OPEN_COWORK_MANAGED_RUNTIME_VALUE
  if (input.enableNativeWebSearch) env.OPENCODE_ENABLE_EXA = '1'
  if (input.adcPath) env.GOOGLE_APPLICATION_CREDENTIALS = input.adcPath
  return env
}
