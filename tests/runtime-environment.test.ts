import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManagedOpencodeServerEnvironment, buildManagedRuntimeEnvironment, resolveManagedOpencodeCommand } from '../apps/desktop/src/main/runtime.ts'
import { OPEN_COWORK_MANAGED_RUNTIME_ENV, OPEN_COWORK_MANAGED_RUNTIME_VALUE } from '../apps/desktop/src/main/runtime-process-cleanup.ts'

const runtimePaths = {
  home: '/tmp/open-cowork/runtime-home',
  configHome: '/tmp/open-cowork/runtime-home/.config',
  dataHome: '/tmp/open-cowork/runtime-home/.local/share',
  cacheHome: '/tmp/open-cowork/runtime-home/.cache',
  stateHome: '/tmp/open-cowork/runtime-home/.local/state',
}

test('managed runtime env keeps toolchain basics and drops arbitrary shell secrets', () => {
  const env = buildManagedRuntimeEnvironment({
    currentEnv: {
      PATH: '/usr/bin:/bin',
      Path: 'C:\\Windows\\System32;C:\\Windows',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      HTTPS_PROXY: 'http://proxy.example:8080',
      HTTP_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      all_proxy: 'socks5://proxy.example:1080',
      APPDATA: 'C:\\Users\\Joe\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Joe\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\Joe',
      OPENAI_API_KEY: 'sk-secret',
      GIT_SSH_COMMAND: 'ssh -i /tmp/attacker-key',
      AWS_SESSION_TOKEN: 'aws-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      OPENCODE_BIN_PATH: '/Applications/Open Cowork.app/Contents/Resources/opencode',
    },
    runtimePaths,
    adcPath: '/tmp/open-cowork/adc.json',
    enableNativeWebSearch: true,
  })

  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Windows')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.LC_CTYPE, 'UTF-8')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080')
  assert.equal(env.HTTP_PROXY, 'http://proxy.example:8080')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(env.all_proxy, 'socks5://proxy.example:1080')
  assert.equal(env.OPENCODE_BIN_PATH, '/Applications/Open Cowork.app/Contents/Resources/opencode')
  assert.equal(env.HOME, runtimePaths.home)
  assert.equal(env.USERPROFILE, runtimePaths.home)
  assert.equal(env.APPDATA, runtimePaths.configHome)
  assert.equal(env.LOCALAPPDATA, runtimePaths.dataHome)
  assert.equal(env.HOMEDRIVE, undefined)
  assert.equal(env.HOMEPATH, undefined)
  assert.equal(env.XDG_CONFIG_HOME, runtimePaths.configHome)
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/open-cowork/adc.json')
  assert.equal(env.OPENCODE_ENABLE_EXA, '1')
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, '1')
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, '1')
  assert.equal(env[OPEN_COWORK_MANAGED_RUNTIME_ENV], OPEN_COWORK_MANAGED_RUNTIME_VALUE)

  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GIT_SSH_COMMAND, undefined)
  assert.equal(env.AWS_SESSION_TOKEN, undefined)
  assert.equal(env.SSH_AUTH_SOCK, undefined)
})

test('managed runtime env maps Windows home variables to the sandbox home', () => {
  const windowsRuntimePaths = {
    home: 'C:\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home',
    configHome: 'C:\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home\\.config',
    dataHome: 'C:\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home\\.local\\share',
    cacheHome: 'C:\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home\\.cache',
    stateHome: 'C:\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home\\.local\\state',
  }

  const env = buildManagedRuntimeEnvironment({
    currentEnv: {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      USERPROFILE: 'C:\\Users\\Joe',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\Joe',
      APPDATA: 'C:\\Users\\Joe\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Joe\\AppData\\Local',
    },
    runtimePaths: windowsRuntimePaths,
  })

  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Windows')
  assert.equal(env.HOME, windowsRuntimePaths.home)
  assert.equal(env.USERPROFILE, windowsRuntimePaths.home)
  assert.equal(env.HOMEDRIVE, 'C:')
  assert.equal(env.HOMEPATH, '\\Users\\Joe\\AppData\\Roaming\\Open Cowork\\runtime-home')
  assert.equal(env.APPDATA, windowsRuntimePaths.configHome)
  assert.equal(env.LOCALAPPDATA, windowsRuntimePaths.dataHome)
})

test('managed runtime server env is explicit and does not mutate main process env', () => {
  const originalEnv = { ...process.env }
  process.env.OPEN_COWORK_USER_DATA_DIR = '/tmp/open-cowork/user-data'
  process.env.PATH = '/usr/bin:/bin'

  try {
    const serverEnv = buildManagedOpencodeServerEnvironment(
      {
        PATH: '/managed/bin',
        HOME: runtimePaths.home,
        [OPEN_COWORK_MANAGED_RUNTIME_ENV]: OPEN_COWORK_MANAGED_RUNTIME_VALUE,
      },
      {
        logLevel: 'debug',
      },
    )

    assert.equal(serverEnv.PATH, '/managed/bin')
    assert.equal(serverEnv.HOME, runtimePaths.home)
    assert.equal(serverEnv[OPEN_COWORK_MANAGED_RUNTIME_ENV], OPEN_COWORK_MANAGED_RUNTIME_VALUE)
    assert.match(serverEnv.OPENCODE_CONFIG_CONTENT || '', /"logLevel":"debug"/)
    assert.equal(serverEnv.OPEN_COWORK_USER_DATA_DIR, undefined)
    assert.equal(process.env.OPEN_COWORK_USER_DATA_DIR, '/tmp/open-cowork/user-data')
    assert.equal(process.env.PATH, '/usr/bin:/bin')
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  }
})

test('managed runtime server prefers the explicit bundled OpenCode binary', () => {
  assert.equal(
    resolveManagedOpencodeCommand({ OPENCODE_BIN_PATH: '/app/resources/opencode/bin/opencode' }),
    '/app/resources/opencode/bin/opencode',
  )
  assert.equal(resolveManagedOpencodeCommand({ OPENCODE_BIN_PATH: '   ' }), 'opencode')
  assert.equal(resolveManagedOpencodeCommand({}), 'opencode')
})
