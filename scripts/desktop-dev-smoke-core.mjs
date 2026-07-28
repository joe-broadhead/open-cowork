import { isAbsolute, relative, resolve, sep } from 'node:path'

const PORTABLE_ENVIRONMENT_KEYS = new Set([
  'COLORTERM',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'LANG',
  'LANGUAGE',
  'PATH',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
])

const DARWIN_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'LOGNAME',
  'SECURITYSESSIONID',
  'USER',
  '__CF_USER_TEXT_ENCODING',
])

const WINDOWS_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'USERPROFILE',
  'WINDIR',
])

function shouldInheritEnvironmentKey(key, platform) {
  if (PORTABLE_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_')) return true
  if (platform === 'darwin') return DARWIN_ENVIRONMENT_KEYS.has(key)
  if (platform === 'win32') return WINDOWS_ENVIRONMENT_KEYS.has(key)
  return false
}

export function createDesktopSmokeEnvironment(
  sourceEnvironment,
  overrides,
  {
    isolatedHome,
    platform = process.platform,
  },
) {
  const environment = {}
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (typeof value !== 'string' || !shouldInheritEnvironmentKey(key, platform)) continue
    environment[key] = value
  }
  if (platform !== 'darwin') environment.HOME = isolatedHome
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') environment[key] = value
  }
  return environment
}

export function desktopRendererProbeUrl(repoRoot, probePath) {
  const rendererSourceRoot = resolve(repoRoot, 'packages/app/src')
  const relativeProbePath = relative(rendererSourceRoot, resolve(probePath))
  if (
    !relativeProbePath
    || relativeProbePath === '..'
    || relativeProbePath.startsWith(`..${sep}`)
    || isAbsolute(relativeProbePath)
  ) {
    throw new Error('Desktop renderer HMR probe must live under packages/app/src')
  }
  const encodedPath = relativeProbePath
    .split(sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `/packages/app/src/${encodedPath}`
}
