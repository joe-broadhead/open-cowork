import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { clearSettingsCache, saveSettings } from '../apps/desktop/src/main/settings.ts'
import {
  buildCustomAgentCatalog,
  buildCustomAgentPermissionFromCatalog,
  buildRuntimeCustomAgents,
  summarizeCustomAgents,
  validateCustomAgent,
} from '../apps/desktop/src/main/custom-agents-utils.ts'
import { CUSTOM_AGENT_LIMITS } from '../apps/desktop/src/main/custom-content-limits.ts'
import { validateCustomAgentConfig } from '../apps/desktop/src/main/ipc/object-validators.ts'

const builtinTools = [
  {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    description: 'Repository and pull request workflows.',
    kind: 'mcp' as const,
    allowPatterns: ['mcp__github__repos_*', 'mcp__github__pull_request_read'],
    askPatterns: ['mcp__github__create_pull_request', 'mcp__github__add_issue_comment'],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    icon: 'perplexity',
    description: 'External web research.',
    kind: 'mcp' as const,
    allowPatterns: ['mcp__perplexity__perplexity_ask', 'mcp__perplexity__perplexity_search'],
  },
] as const

const builtinSkills = [
  {
    name: 'GitHub',
    description: 'Triage repository work.',
    badge: 'Skill' as const,
    sourceName: 'github:github',
    toolIds: ['github'],
  },
] as const

const baseSettings = {
  customMcps: [],
  customSkills: [],
  customAgents: [],
  integrationCredentials: {},
}

function withConfigOverride(config: Record<string, unknown>, run: () => void) {
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-custom-agent-policy-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  process.env.OPEN_COWORK_USER_DATA_DIR = join(tempRoot, 'user-data')
  clearConfigCaches()
  clearSettingsCache()
  try {
    run()
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    clearSettingsCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('custom agent catalog exposes configured built-in tools and skills', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  assert.deepEqual(catalog.tools.map((tool) => tool.id), ['github', 'perplexity', 'task'])
  assert.equal(catalog.tools[0]?.supportsWrite, true)
  assert.equal(catalog.tools.find((tool) => tool.id === 'task')?.supportsWrite, true)
  assert.equal(catalog.skills.some((skill) => skill.name === 'github:github'), true)
  assert.equal(catalog.reservedNames.includes('build'), true)
  assert.equal(catalog.reservedNames.includes('chief-of-staff'), true)
  assert.equal(catalog.reservedNames.includes('cleo'), true)
})

test('custom agent catalog includes custom skills alongside bundled skills', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    state: baseSettings,
  })

  assert.equal(catalog.skills.some((skill) => skill.name === 'sales-review' && skill.source === 'custom'), true)
})

test('custom agent catalog includes native runtime tools with native permissions', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    runtimeTools: [
      { id: 'websearch', description: 'Search the web.' },
      { id: 'bash', description: 'Execute shell commands.' },
    ],
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const websearch = catalog.tools.find((tool) => tool.id === 'websearch')
  const bash = catalog.tools.find((tool) => tool.id === 'bash')

  assert.equal(websearch?.name, 'Web Search')
  assert.deepEqual(websearch?.allowPatterns, ['websearch'])
  assert.deepEqual(websearch?.askPatterns, [])
  assert.equal(websearch?.supportsWrite, false)

  assert.equal(bash?.name, 'Bash')
  assert.deepEqual(bash?.allowPatterns, [])
  assert.deepEqual(bash?.askPatterns, ['bash'])
  assert.equal(bash?.supportsWrite, true)
})

test('custom agent catalog accepts the effective Cowork-only skill catalog', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    availableSkills: [
      {
        name: 'analyst',
        label: 'Analyst',
        description: 'Analyze metrics and compare trends.',
        source: 'custom',
        origin: 'custom',
        scope: 'project',
        location: '/tmp/project/.opencowork/skills/analyst/SKILL.md',
      },
    ],
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  assert.equal(catalog.skills.some((skill) => skill.name === 'analyst'), true)
})

test('custom agents become invalid when they collide with reserved names or lose dependencies', () => {
  const settings = {
    ...baseSettings,
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    customAgents: [
      {
        name: 'build',
        description: 'Should fail',
        instructions: '',
        skillNames: ['sales-review'],
        toolIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
      {
        name: 'repo-maintainer',
        description: 'Handle repository work',
        instructions: '',
        skillNames: ['missing-skill'],
        toolIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
      {
        name: 'cleo',
        description: 'Should fail because Cleo is a built-in display name',
        instructions: '',
        skillNames: ['sales-review'],
        toolIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
    ],
  }

  const summaries = summarizeCustomAgents({
    state: settings,
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(summaries[0]?.valid, false)
  assert.equal(summaries[0]?.issues.some((issue) => issue.code === 'reserved_name'), true)
  assert.equal(summaries[1]?.valid, false)
  assert.equal(summaries[1]?.issues.some((issue) => issue.code === 'missing_skill'), true)
  assert.equal(summaries[2]?.valid, false)
  assert.equal(summaries[2]?.issues.some((issue) => issue.code === 'reserved_name'), true)
})

test('custom agent validation rejects oversized payloads and unbounded selections', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const issues = validateCustomAgent({
    name: 'heavy-agent',
    description: 'Analyze a bounded request.',
    instructions: 'x'.repeat(CUSTOM_AGENT_LIMITS.instructionsBytes + 1),
    skillNames: Array.from({ length: CUSTOM_AGENT_LIMITS.skillNames + 1 }, (_, index) => `skill-${index}`),
    toolIds: [],
    enabled: true,
    color: 'accent',
    avatar: 'x'.repeat(CUSTOM_AGENT_LIMITS.avatarBytes + 1),
    deniedToolPatterns: Array.from({ length: CUSTOM_AGENT_LIMITS.deniedToolPatterns + 1 }, (_, index) => `mcp__tool__${index}`),
  }, catalog)

  assert.equal(issues.some((issue) => issue.code === 'instructions_too_large'), true)
  assert.equal(issues.some((issue) => issue.code === 'avatar_too_large'), true)
  assert.equal(issues.some((issue) => issue.code === 'too_many_skills'), true)
  assert.equal(issues.some((issue) => issue.code === 'too_many_denied_tool_patterns'), true)
})

test('custom agent IPC validation rejects permission rule control characters', () => {
  assert.throws(() => validateCustomAgentConfig({
    scope: 'machine',
    name: 'unsafe-rule',
    description: 'Unsafe rule',
    instructions: 'Do work.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
    permissionOverrides: [
      {
        key: 'bash',
        action: 'deny',
        rules: [{ pattern: 'git *\nrm *', action: 'allow' }],
      },
    ],
  }), /pattern cannot contain line breaks or null bytes/)
})

test('custom agent validation treats shared option references as serializable depth', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })
  const shared = { filters: { region: 'EMEA' } }

  const issues = validateCustomAgent({
    name: 'analyst',
    description: 'Analyze a bounded request.',
    instructions: 'Work carefully.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
    options: { primary: shared, secondary: shared },
  }, catalog)

  assert.equal(issues.some((issue) => issue.code === 'options_too_deep'), false)
  assert.equal(issues.some((issue) => issue.code === 'options_not_json_serializable'), false)
})

test('custom agent summaries preserve avatar metadata for renderer cards', () => {
  const summaries = summarizeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'insights',
          description: 'Investigate dashboards',
          instructions: 'Work carefully.',
          skillNames: [],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
          avatar: 'data:image/png;base64,FAKE',
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(summaries[0]?.avatar, 'data:image/png;base64,FAKE')
})

test('runtime custom agents derive allow and ask patterns from selected tools', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customSkills: [{ name: 'sales-review', content: '# Sales Review' }],
      customAgents: [
        {
          name: 'repo-maintainer',
          description: 'Handle repository work',
          instructions: 'Work carefully.',
          skillNames: ['sales-review'],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.name, 'repo-maintainer')
  assert.deepEqual(runtimeAgents[0]?.skillNames, ['sales-review'])
  assert.equal(runtimeAgents[0]?.writeAccess, true)
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__github__repos_*'), true)
  assert.equal(runtimeAgents[0]?.askPatterns.includes('mcp__github__create_pull_request'), true)
})

test('runtime custom agents keep disabled valid agents visible to the SDK disable flag', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'parked-specialist',
          description: 'Valid but disabled by the user.',
          instructions: 'Stay parked.',
          skillNames: [],
          toolIds: ['github'],
          enabled: false,
          color: 'warning' as const,
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.name, 'parked-specialist')
  assert.equal(runtimeAgents[0]?.disabled, true)
})

test('runtime custom agents carry deniedToolPatterns through to the SDK payload', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'scoped-maintainer',
          description: 'Narrowly scoped repo maintainer',
          instructions: 'Do not delete anything.',
          skillNames: [],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
          deniedToolPatterns: ['mcp__github__delete_repo', '  ', 'mcp__github__delete_repo'],
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  // Entries should be de-duped, trimmed, and expanded to both known
  // OpenCode MCP permission spellings so the SDK gets a clean list.
  assert.deepEqual(runtimeAgents[0]?.deniedPatterns, ['mcp__github__delete_repo', 'github_delete_repo'])
  // The parent MCP's allow stays intact — only the specific method is denied.
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__github__repos_*'), true)
})

test('custom agent permission overrides emit collapsed OpenCode permission keys', () => {
  withConfigOverride({
    permissions: {
      bash: 'allow',
      fileWrite: 'allow',
      task: 'allow',
      web: 'allow',
      webSearch: true,
    },
  }, () => {
    saveSettings({
      bashPermission: 'allow',
      fileWritePermission: 'allow',
      enableBash: true,
      enableFileWrite: true,
    })
    const catalog = buildCustomAgentCatalog({
      builtinTools: builtinTools as any,
      builtinSkills: builtinSkills as any,
      customMcps: [],
      customSkills: [],
      state: baseSettings,
    })

    const permission = buildCustomAgentPermissionFromCatalog({
      name: 'careful-maintainer',
      description: 'Maintains repos with explicit guardrails.',
      instructions: 'Work carefully.',
      skillNames: [],
      toolIds: ['github'],
      enabled: true,
      color: 'accent' as const,
      permissionOverrides: [
        { key: 'web', action: 'allow', rules: [{ pattern: 'example.com/*', action: 'deny' }] },
        { key: 'edit', action: 'deny', rules: [{ pattern: '*.md', action: 'allow' }] },
        { key: 'bash', action: 'deny', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
        { key: 'task', action: 'ask', rules: [{ pattern: 'build', action: 'allow' }] },
        { key: 'external_directory', action: 'deny', rules: [{ pattern: '/tmp/shared/*', action: 'allow' }] },
        { key: 'mcp', action: 'ask', rules: [{ pattern: 'mcp__github__delete-repo', action: 'deny' }] },
      ],
    }, catalog)

    assert.equal(permission.codesearch, 'allow')
    assert.equal(permission.webfetch, 'allow')
    assert.equal(permission.websearch, 'allow')
    assert.deepEqual(permission.edit, { '*': 'deny', '*.md': 'allow' })
    assert.deepEqual(permission.write, { '*': 'deny', '*.md': 'allow' })
    assert.deepEqual(permission.apply_patch, { '*': 'deny', '*.md': 'allow' })
    assert.equal(permission['*.md'], undefined)
    assert.deepEqual(permission.bash, { '*': 'deny', 'pnpm test': 'allow' })
    assert.equal(permission['pnpm test'], undefined)
    assert.deepEqual(permission.task, { '*': 'ask', build: 'allow' })
    assert.deepEqual(permission.external_directory, { '*': 'deny', '/tmp/shared/*': 'allow' })
    assert.equal(permission['example.com/*'], undefined)
    assert.equal(permission.build, undefined)
    assert.equal(permission['/tmp/shared/*'], undefined)
    assert.equal(permission['mcp__*'], 'ask')
    assert.equal(permission.mcp__github__pull_request_read, 'ask')
    assert.equal(permission.github_pull_request_read, 'ask')
    assert.equal(permission['mcp__github__delete-repo'], 'deny')
    assert.equal(permission['github_delete-repo'], 'deny')
    const permissionKeys = Object.keys(permission)
    assert.ok(permissionKeys.indexOf('mcp__github__create_pull_request') < permissionKeys.indexOf('mcp__*'))
    assert.ok(permissionKeys.indexOf('mcp__*') < permissionKeys.indexOf('mcp__github__delete-repo'))
  })
})

test('custom agent permission overrides cannot exceed app permission caps', () => {
  withConfigOverride({
    permissions: {
      bash: 'ask',
      fileWrite: 'deny',
      task: 'ask',
      web: 'ask',
      webSearch: false,
    },
  }, () => {
    const catalog = buildCustomAgentCatalog({
      builtinTools: builtinTools as any,
      builtinSkills: builtinSkills as any,
      customMcps: [],
      customSkills: [],
      state: baseSettings,
    })

    const permission = buildCustomAgentPermissionFromCatalog({
      name: 'capped-maintainer',
      description: 'Requests permissions above downstream caps.',
      instructions: 'Work carefully.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent' as const,
      permissionOverrides: [
        { key: 'web', action: 'allow' },
        { key: 'edit', action: 'allow', rules: [{ pattern: '*.md', action: 'ask' }] },
        { key: 'bash', action: 'allow', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
        { key: 'task', action: 'allow', rules: [{ pattern: 'build', action: 'allow' }] },
        { key: 'external_directory', action: 'allow', rules: [{ pattern: '/tmp/shared/*', action: 'allow' }] },
      ],
    }, catalog)

    assert.equal(permission.codesearch, 'ask')
    assert.equal(permission.webfetch, 'ask')
    assert.equal(permission.websearch, 'deny')
    assert.deepEqual(permission.edit, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.write, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.apply_patch, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.bash, { '*': 'ask', 'pnpm test': 'ask' })
    assert.deepEqual(permission.task, { '*': 'ask', build: 'ask' })
    assert.deepEqual(permission.external_directory, { '*': 'deny', '/tmp/shared/*': 'deny' })
  })
})

test('custom agent permission overrides honor user-disabled shell and write settings', () => {
  withConfigOverride({
    permissions: {
      bash: 'allow',
      fileWrite: 'allow',
      task: 'allow',
      web: 'allow',
      webSearch: true,
    },
  }, () => {
    saveSettings({
      bashPermission: 'deny',
      fileWritePermission: 'deny',
      enableBash: false,
      enableFileWrite: false,
    })
    const catalog = buildCustomAgentCatalog({
      builtinTools: builtinTools as any,
      builtinSkills: builtinSkills as any,
      customMcps: [],
      customSkills: [],
      state: baseSettings,
    })

    const permission = buildCustomAgentPermissionFromCatalog({
      name: 'locally-disabled-maintainer',
      description: 'Requests permissions disabled in user settings.',
      instructions: 'Work carefully.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent' as const,
      permissionOverrides: [
        { key: 'edit', action: 'allow', rules: [{ pattern: '*.md', action: 'allow' }] },
        { key: 'bash', action: 'allow', rules: [{ pattern: 'pnpm test', action: 'allow' }] },
        { key: 'external_directory', action: 'allow', rules: [{ pattern: '/tmp/shared/*', action: 'allow' }] },
      ],
    }, catalog)

    assert.deepEqual(permission.edit, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.write, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.apply_patch, { '*': 'deny', '*.md': 'deny' })
    assert.deepEqual(permission.bash, { '*': 'deny', 'pnpm test': 'deny' })
    assert.deepEqual(permission.external_directory, { '*': 'deny', '/tmp/shared/*': 'deny' })
  })
})

test('custom agent MCP deny override is applied after selected MCP tool patterns', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const permission = buildCustomAgentPermissionFromCatalog({
    name: 'mcp-locked',
    description: 'Keeps MCPs off.',
    instructions: 'Do not use MCPs.',
    skillNames: [],
    toolIds: ['github'],
    enabled: true,
    color: 'accent' as const,
    permissionOverrides: [
      { key: 'mcp', action: 'deny' },
    ],
  }, catalog)

  assert.equal(permission['mcp__*'], 'deny')
  assert.equal(permission['mcp__github__repos_*'], 'deny')
  assert.equal(permission['github_repos_*'], 'deny')
  assert.equal(permission.mcp__github__pull_request_read, 'deny')
  assert.equal(permission.github_pull_request_read, 'deny')
  assert.equal(permission.mcp__github__create_pull_request, 'deny')
  assert.equal(permission.github_create_pull_request, 'deny')
  const permissionKeys = Object.keys(permission)
  assert.ok(permissionKeys.indexOf('mcp__github__pull_request_read') < permissionKeys.indexOf('mcp__*'))
})

test('custom agent MCP deny override also covers alias-only MCP tool patterns', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })
  const aliasOnlyCatalog = {
    ...catalog,
    tools: [
      ...catalog.tools,
      {
        id: 'legacy-github',
        name: 'Legacy GitHub',
        icon: 'plug',
        description: 'Legacy alias-form MCP tool.',
        supportsWrite: true,
        source: 'builtin' as const,
        patterns: ['github_*'],
        allowPatterns: ['github_*'],
        askPatterns: [],
      },
    ],
  }

  const permission = buildCustomAgentPermissionFromCatalog({
    name: 'legacy-mcp-locked',
    description: 'Keeps alias-only MCPs off.',
    instructions: 'Do not use MCPs.',
    skillNames: [],
    toolIds: ['legacy-github'],
    enabled: true,
    color: 'accent' as const,
    permissionOverrides: [
      { key: 'mcp', action: 'deny' },
    ],
  }, aliasOnlyCatalog)

  assert.equal(permission['mcp__*'], 'deny')
  assert.equal(permission['github_*'], 'deny')
})

test('custom agent MCP default overrides do not rewrite native repo permissions', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })
  const repoCatalog = {
    ...catalog,
    tools: [
      ...catalog.tools,
      {
        id: 'repo-native',
        name: 'Native Repo',
        icon: 'repo',
        description: 'Native OpenCode repository permissions.',
        supportsWrite: true,
        source: 'builtin' as const,
        patterns: ['repo_clone', 'repo_overview'],
        allowPatterns: ['repo_clone'],
        askPatterns: ['repo_overview'],
      },
    ],
  }

  const permission = buildCustomAgentPermissionFromCatalog({
    name: 'repo-native-guarded',
    description: 'Uses native repo tools and denies MCPs.',
    instructions: 'Keep MCPs off.',
    skillNames: [],
    toolIds: ['repo-native'],
    enabled: true,
    color: 'accent' as const,
    permissionOverrides: [
      { key: 'mcp', action: 'deny' },
    ],
  }, repoCatalog)

  assert.equal(permission['mcp__*'], 'deny')
  assert.equal(permission.repo_clone, 'allow')
  assert.equal(permission.repo_overview, 'ask')
})

test('custom agent MCP permission rules cannot grant native tool permissions', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const permission = buildCustomAgentPermissionFromCatalog({
    name: 'mcp-rule-scoped',
    description: 'Only scopes MCP tool permissions.',
    instructions: 'Use approved MCP tools only.',
    skillNames: [],
    toolIds: ['github'],
    enabled: true,
    color: 'accent' as const,
    permissionOverrides: [
      {
        key: 'mcp',
        action: 'deny',
        rules: [
          { pattern: 'bash', action: 'allow' },
          { pattern: 'mcp__github__pull_request_read', action: 'allow' },
        ],
      },
    ],
  }, catalog)

  assert.notEqual(permission.bash, 'allow')
  assert.equal(permission['mcp__*'], 'deny')
  assert.equal(permission.mcp__github__pull_request_read, 'allow')
  assert.equal(permission.github_pull_request_read, 'allow')
})

test('custom agent validation rejects invalid MCP permission rule patterns', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const issues = validateCustomAgent({
    name: 'mcp-rule-invalid',
    description: 'Rejects malformed MCP tool rules.',
    instructions: 'Use approved MCP tools only.',
    skillNames: [],
    toolIds: ['github'],
    enabled: true,
    color: 'accent' as const,
    permissionOverrides: [
      {
        key: 'mcp',
        action: 'allow',
        rules: [
          { pattern: 'mcp__github/delete_repo', action: 'deny' },
        ],
      },
    ],
  }, catalog)

  assert.equal(issues.some((issue) => issue.code === 'permission_rule_pattern_invalid_mcp_0_0'), true)
  assert.equal(
    issues.some((issue) => issue.message === 'MCP tools permission rule pattern must be an MCP tool pattern like mcp__server__tool or server_tool.'),
    true,
  )
})

test('runtime custom agents expose saved mode and write access from permission overrides', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'writer-lead',
          description: 'Leads writing sessions.',
          instructions: 'Draft carefully.',
          skillNames: [],
          toolIds: [],
          enabled: true,
          color: 'success' as const,
          mode: 'primary' as const,
          permissionOverrides: [
            { key: 'task', action: 'ask' },
          ],
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.mode, 'primary')
  assert.equal(runtimeAgents[0]?.writeAccess, true)
})

test('runtime custom agents respect deny overrides when deriving write access', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'safe-shell',
          description: 'Shell tool selected but denied.',
          instructions: 'Do not run shell commands.',
          skillNames: [],
          toolIds: ['bash'],
          enabled: true,
          color: 'accent' as const,
          permissionOverrides: [
            { key: 'bash', action: 'deny' },
          ],
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    runtimeTools: [{ id: 'bash', description: 'Run shell commands.' }],
  })

  assert.equal(runtimeAgents[0]?.writeAccess, false)
})

test('custom MCP tools default to ask-only access', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [
      {
        name: 'warehouse',
        label: 'Warehouse',
        description: 'Custom warehouse MCP',
      },
    ],
    customSkills: [],
    state: baseSettings,
  })

  const warehouse = catalog.tools.find((tool) => tool.id === 'warehouse')
  assert.deepEqual(warehouse?.allowPatterns, [])
  assert.deepEqual(warehouse?.askPatterns, ['mcp__warehouse__*', 'warehouse_*'])
})

test('trusted custom MCP tools become allow access', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [
      {
        name: 'warehouse',
        label: 'Warehouse',
        description: 'Custom warehouse MCP',
        permissionMode: 'allow',
      },
    ],
    customSkills: [],
    state: baseSettings,
  })

  const warehouse = catalog.tools.find((tool) => tool.id === 'warehouse')
  assert.deepEqual(warehouse?.allowPatterns, ['mcp__warehouse__*', 'warehouse_*'])
  assert.deepEqual(warehouse?.askPatterns, [])
})

test('runtime custom agents inherit trusted custom MCP allow patterns', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customMcps: [
        {
          name: 'nova',
          label: 'Nova',
          description: 'Data analysis MCP',
          permissionMode: 'allow',
        },
      ],
      customAgents: [
        {
          name: 'data-analyst',
          description: 'Analyze business metrics',
          instructions: 'Use Nova for metric lookup.',
          skillNames: [],
          toolIds: ['nova'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.deepEqual(runtimeAgents[0]?.allowPatterns, ['mcp__nova__*', 'nova_*'])
  assert.deepEqual(runtimeAgents[0]?.askPatterns, [])
})
