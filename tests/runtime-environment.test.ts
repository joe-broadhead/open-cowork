import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManagedRuntimeEnvironment } from '../apps/desktop/src/main/runtime.ts'
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
