import { OPEN_COWORK_MANAGED_RUNTIME_ENV, OPEN_COWORK_MANAGED_RUNTIME_VALUE } from '@open-cowork/runtime-host/runtime-process-cleanup'
import { buildManagedOpencodeAuthorizationHeader, buildManagedOpencodeServerEnvironment, createManagedOpencodeServerAuth, drainManagedOpencodeProcessOutput, parseManagedOpencodeServerStdoutChunk, resolveManagedOpencodeCommand, resolveManagedOpencodeSpawn } from '@open-cowork/runtime-host/runtime-managed-server'
import { buildManagedRuntimeEnvironment } from '@open-cowork/runtime-host/runtime-environment'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-node.pem',
      SSL_CERT_FILE: '/etc/ssl/corp.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      REQUESTS_CA_BUNDLE: '/etc/ssl/python.pem',
      CURL_CA_BUNDLE: '/etc/ssl/curl.pem',
      GIT_SSL_CAINFO: '/etc/ssl/git.pem',
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
      SSH_AGENT_PID: '12345',
      OPENCODE_BIN_PATH: '/tmp/untrusted-opencode',
    },
    runtimePaths,
    adcPath: '/tmp/open-cowork/adc.json',
    enableNativeWebSearch: true,
    serverAuth: {
      username: 'opencode',
      password: 'runtime-password',
      authorizationHeader: buildManagedOpencodeAuthorizationHeader({
        username: 'opencode',
        password: 'runtime-password',
      }),
    },
  })

  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Windows')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.LC_CTYPE, 'UTF-8')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/corp-node.pem')
  assert.equal(env.SSL_CERT_FILE, '/etc/ssl/corp.pem')
  assert.equal(env.SSL_CERT_DIR, '/etc/ssl/certs')
  assert.equal(env.REQUESTS_CA_BUNDLE, '/etc/ssl/python.pem')
  assert.equal(env.CURL_CA_BUNDLE, '/etc/ssl/curl.pem')
  assert.equal(env.GIT_SSL_CAINFO, '/etc/ssl/git.pem')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080')
  assert.equal(env.HTTP_PROXY, 'http://proxy.example:8080')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(env.all_proxy, 'socks5://proxy.example:1080')
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
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1')
  assert.equal(env.OPENCODE_DISABLE_EMBEDDED_WEB_UI, 'true')
  assert.equal(env.OPENCODE_SERVER_USERNAME, 'opencode')
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'runtime-password')
  assert.equal(env[OPEN_COWORK_MANAGED_RUNTIME_ENV], OPEN_COWORK_MANAGED_RUNTIME_VALUE)

  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GIT_SSH_COMMAND, undefined)
  assert.equal(env.AWS_SESSION_TOKEN, undefined)
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.SSH_AGENT_PID, undefined)
  assert.equal(env.OPENCODE_BIN_PATH, undefined)
})

test('managed runtime env can deliberately use native OpenCode config roots', () => {
  const nativePaths = {
    home: '/Users/example',
    configHome: '/Users/example/.config',
    dataHome: '/Users/example/.local/share',
    cacheHome: '/Users/example/.cache',
    stateHome: '/Users/example/.local/state',
  }
  const env = buildManagedRuntimeEnvironment({
    currentEnv: {
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'sk-secret',
      OPENCODE_CONFIG_CONTENT: '{"agent":{}}',
    },
    runtimePaths: nativePaths,
  })

  assert.equal(env.HOME, nativePaths.home)
  assert.equal(env.XDG_CONFIG_HOME, nativePaths.configHome)
  assert.equal(env.XDG_DATA_HOME, nativePaths.dataHome)
  assert.equal(env.XDG_CACHE_HOME, nativePaths.cacheHome)
  assert.equal(env.XDG_STATE_HOME, nativePaths.stateHome)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
})

test('managed runtime env drops inherited opencode binary overrides', () => {
  const env = buildManagedRuntimeEnvironment({
    currentEnv: {
      PATH: '/usr/bin:/bin',
      OPENCODE_BIN_PATH: '/tmp/untrusted-opencode',
    },
    runtimePaths,
  })

  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.OPENCODE_BIN_PATH, undefined)
})

test('managed runtime server auth generates Basic auth without mutating the password', () => {
  const auth = createManagedOpencodeServerAuth()

  assert.equal(auth.username, 'opencode')
  assert.equal(auth.password.length > 30, true)
  assert.equal(
    auth.authorizationHeader,
    buildManagedOpencodeAuthorizationHeader({
      username: auth.username,
      password: auth.password,
    }),
  )
  assert.equal(auth.authorizationHeader.startsWith('Basic '), true)
  assert.equal(auth.authorizationHeader.includes(auth.password), false)
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
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\Joe',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\Joe',
      APPDATA: 'C:\\Users\\Joe\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Joe\\AppData\\Local',
    },
    runtimePaths: windowsRuntimePaths,
  })

  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Windows')
  assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe')
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
    let configContent = ''
    const serverEnv = buildManagedOpencodeServerEnvironment(
      {
        PATH: '/managed/bin',
        HOME: runtimePaths.home,
        [OPEN_COWORK_MANAGED_RUNTIME_ENV]: OPEN_COWORK_MANAGED_RUNTIME_VALUE,
      },
      {
        logLevel: 'debug',
      },
      {
        writeConfigFile: (serialized) => {
          configContent = serialized
          return '/tmp/open-cowork-config/opencode.json'
        },
      },
    )

    assert.equal(serverEnv.PATH, '/managed/bin')
    assert.equal(serverEnv.HOME, runtimePaths.home)
    assert.equal(serverEnv[OPEN_COWORK_MANAGED_RUNTIME_ENV], OPEN_COWORK_MANAGED_RUNTIME_VALUE)
    assert.equal(serverEnv.OPENCODE_CONFIG_CONTENT, undefined)
    assert.equal(serverEnv.OPENCODE_CONFIG, undefined)
    assert.equal(serverEnv.OPENCODE_CONFIG_DIR, '/tmp/open-cowork-config')
    assert.match(configContent, /"logLevel":"debug"/)
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

test('managed runtime server env omits Cowork config content in machine-config mode', () => {
  const serverEnv = buildManagedOpencodeServerEnvironment(
    {
      PATH: '/managed/bin',
      HOME: '/Users/example',
      OPENCODE_CONFIG_CONTENT: '{"stale":true}',
    },
    undefined,
  )

  assert.equal(serverEnv.PATH, '/managed/bin')
  assert.equal(serverEnv.HOME, '/Users/example')
  assert.equal(serverEnv.OPENCODE_CONFIG_CONTENT, undefined)
})

test('managed runtime server prefers the explicit bundled OpenCode binary', () => {
  assert.equal(
    resolveManagedOpencodeCommand('/app/resources/opencode/bin/opencode'),
    '/app/resources/opencode/bin/opencode',
  )
  assert.equal(resolveManagedOpencodeCommand('   '), 'opencode')
  assert.equal(resolveManagedOpencodeCommand(null), 'opencode')
})

test('managed runtime spawn launches explicit binaries directly', () => {
  const args = ['serve', '--hostname=127.0.0.1', '--port=4096']
  const spawnPlan = resolveManagedOpencodeSpawn(
    { OPENCODE_BIN_PATH: 'C:\\untrusted\\opencode.exe', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    args,
    'win32',
    'C:\\Program Files\\Open Cowork\\resources\\opencode.exe',
  )

  assert.deepEqual(spawnPlan, {
    command: 'C:\\Program Files\\Open Cowork\\resources\\opencode.exe',
    args,
  })
})

test('managed runtime spawn uses cmd.exe for the Windows wrapper fallback', () => {
  const spawnPlan = resolveManagedOpencodeSpawn(
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    ['serve', '--hostname=127.0.0.1', '--port=4096'],
    'win32',
  )

  assert.deepEqual(spawnPlan, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'opencode', 'serve', '--hostname=127.0.0.1', '--port=4096'],
  })
})

test('managed runtime spawn keeps non-Windows wrapper fallback direct', () => {
  assert.deepEqual(resolveManagedOpencodeSpawn({}, ['serve'], 'linux'), {
    command: 'opencode',
    args: ['serve'],
  })
})

test('managed runtime server stdout parser buffers split startup lines', () => {
  const first = parseManagedOpencodeServerStdoutChunk('', 'debug\nopencode server listening')
  assert.deepEqual(first, { buffer: 'opencode server listening' })

  const second = parseManagedOpencodeServerStdoutChunk(first.buffer, ' on http://127.0.0.1:4096\n')
  assert.deepEqual(second, {
    buffer: '',
    url: 'http://127.0.0.1:4096',
  })
})

test('managed runtime server stdout parser waits for newline before resolving startup lines', () => {
  assert.deepEqual(
    parseManagedOpencodeServerStdoutChunk('', 'opencode server listening on http://127.0.0.1:4096'),
    {
      buffer: 'opencode server listening on http://127.0.0.1:4096',
    },
  )
})

test('managed runtime server stdout parser buffers startup URLs split across chunks', () => {
  const first = parseManagedOpencodeServerStdoutChunk('', 'opencode server listening on http://127.0.0.1:')
  assert.deepEqual(first, {
    buffer: 'opencode server listening on http://127.0.0.1:',
  })

  const second = parseManagedOpencodeServerStdoutChunk(first.buffer, '4096\n')
  assert.deepEqual(second, {
    buffer: '',
    url: 'http://127.0.0.1:4096',
  })
})

test('managed runtime server stdout parser rejects malformed complete startup lines', () => {
  assert.deepEqual(
    parseManagedOpencodeServerStdoutChunk('', 'opencode server listening\n'),
    {
      buffer: '',
      error: 'Failed to parse server url from output: opencode server listening',
    },
  )
})

test('managed runtime drains stdio after startup parsing is detached', () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  assert.equal(stdout.readableFlowing, null)
  assert.equal(stderr.readableFlowing, null)

  drainManagedOpencodeProcessOutput({
    stdout,
    stderr,
  })

  assert.equal(stdout.readableFlowing, true)
  assert.equal(stderr.readableFlowing, true)
})

test('managed opencode server env writes every composed config to the native V2 config directory', async () => {
  let smallWritten: string | null = null
  const small = buildManagedOpencodeServerEnvironment({ PATH: '/bin' }, { agent: {} }, {
    writeConfigFile: (serialized) => {
      smallWritten = serialized
      return '/tmp/open-cowork-small-config/opencode.json'
    },
  })
  assert.equal(small.OPENCODE_CONFIG_CONTENT, undefined)
  assert.equal(small.OPENCODE_CONFIG, undefined)
  assert.equal(small.OPENCODE_CONFIG_DIR, '/tmp/open-cowork-small-config')
  assert.match(smallWritten || '', /"agent"/)

  // Oversized config uses the same file contract, avoiding Linux's
  // MAX_ARG_STRLEN without creating a second runtime configuration path.
  const bigConfig = { instructions: ['x'.repeat(150_000)] }
  let written: string | null = null
  const big = buildManagedOpencodeServerEnvironment({ PATH: '/bin' }, bigConfig, {
    writeConfigFile: (serialized) => {
      written = serialized
      return '/tmp/open-cowork-big-config/opencode.json'
    },
  })
  assert.equal(big.OPENCODE_CONFIG_CONTENT, undefined)
  assert.equal(big.OPENCODE_CONFIG, undefined)
  assert.equal(big.OPENCODE_CONFIG_DIR, '/tmp/open-cowork-big-config')
  assert.match(written || '', /"instructions"/)

  // Real file path variant: written 0600 into a private temp dir.
  const real = buildManagedOpencodeServerEnvironment({ PATH: '/bin' }, bigConfig)
  const fs = await import('node:fs')
  assert.ok(real.OPENCODE_CONFIG_DIR, 'expected a native config directory')
  const realConfigFile = join(real.OPENCODE_CONFIG_DIR, 'opencode.json')
  // Single descriptor for stat + read (no check-then-use race).
  const fd = fs.openSync(realConfigFile, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600)
    }
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'))
    assert.equal(parsed.instructions[0].length, 150_000)
  } finally {
    fs.closeSync(fd)
    fs.rmSync(real.OPENCODE_CONFIG_DIR, { recursive: true, force: true })
  }
})

test('managed opencode server snapshots enabled native agents into the V2 config directory', async () => {
  const fs = await import('node:fs')
  const sourceConfigHome = fs.mkdtempSync(join(tmpdir(), 'open-cowork-native-agent-source-'))
  const sourceAgentsDir = join(sourceConfigHome, 'opencode', 'agents')
  fs.mkdirSync(sourceAgentsDir, { recursive: true })
  fs.writeFileSync(join(sourceAgentsDir, 'reviewer.md'), '---\ndescription: Reviewer\n---\nReview carefully.\n')
  fs.writeFileSync(join(sourceAgentsDir, 'paused.disabled.md'), '---\ndescription: Paused\n---\nDo not load.\n')
  fs.writeFileSync(join(sourceAgentsDir, 'reviewer.opencowork.json'), '{"color":"accent"}\n')

  const serverEnv = buildManagedOpencodeServerEnvironment(
    { PATH: '/bin', XDG_CONFIG_HOME: sourceConfigHome },
    { agent: {} },
  )

  assert.ok(serverEnv.OPENCODE_CONFIG_DIR, 'expected a native config directory')
  try {
    const runtimeAgentsDir = join(serverEnv.OPENCODE_CONFIG_DIR, 'agents')
    assert.equal(
      fs.readFileSync(join(runtimeAgentsDir, 'reviewer.md'), 'utf8'),
      '---\ndescription: Reviewer\n---\nReview carefully.\n',
    )
    assert.equal(fs.existsSync(join(runtimeAgentsDir, 'paused.disabled.md')), false)
    assert.equal(fs.existsSync(join(runtimeAgentsDir, 'reviewer.opencowork.json')), false)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(join(runtimeAgentsDir, 'reviewer.md')).mode & 0o777, 0o600)
    }
  } finally {
    fs.rmSync(serverEnv.OPENCODE_CONFIG_DIR, { recursive: true, force: true })
    fs.rmSync(sourceConfigHome, { recursive: true, force: true })
  }
})
