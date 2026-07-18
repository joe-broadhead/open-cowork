import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { GATEWAY_MCP_TOOL_NAMES } from '../gateway-tools.js'
import { GATEWAY_AGENT_NAMES, GATEWAY_SKILL_NAMES, installGatewayOpenCodeAssets } from '../opencode-defaults.js'
import { deleteOpenCodeAgent, deleteOpenCodeMcp, deleteOpenCodeSkill, deleteOpenCodeTool, listOpenCodeAgents, listOpenCodeMcp, listOpenCodeSkills, listOpenCodeTools, upsertOpenCodeAgent, upsertOpenCodeMcp, upsertOpenCodeSkill, upsertOpenCodeTool } from '../opencode-assets.js'

describe('opencode assets', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-assets-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    delete process.env['OPENCODE_CONFIG_DIR']
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    process.env['OPENCODE_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = path.join(testDir, 'gateway')
    clearConfigCacheForTest()
    fs.writeFileSync(path.join(testDir, 'opencode.jsonc'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', skills: { paths: ['./skills'] } }, null, 2))
  })

  afterEach(() => {
    delete process.env['OPENCODE_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
  })

  it('upserts and deletes OpenCode agents in opencode.jsonc', () => {
    const agent = upsertOpenCodeAgent({ configDir: testDir, name: 'review-bot', model: 'openrouter/test-model', prompt: 'Review carefully.', tools: { edit: false } })

    expect(agent).toMatchObject({ model: 'openrouter/test-model', prompt: 'Review carefully.', mode: 'subagent', tools: { edit: false } })
    expect(listOpenCodeAgents(testDir)).toHaveProperty('review-bot')
    expect(deleteOpenCodeAgent('review-bot', testDir)).toBe(true)
    expect(listOpenCodeAgents(testDir)).not.toHaveProperty('review-bot')
    expect(fs.existsSync(path.join(testDir, 'opencode.jsonc.bak'))).toBe(true)
  })

  it('upserts and deletes OpenCode skills under configured skills path', () => {
    const skill = upsertOpenCodeSkill({ configDir: testDir, name: 'ship-check', content: '# Ship Check\n\nVerify release readiness.' })

    expect(fs.readFileSync(skill.path, 'utf-8')).toContain('Verify release readiness')
    expect(listOpenCodeSkills(testDir)).toEqual([{ name: 'ship-check', path: path.join(testDir, 'skills', 'ship-check', 'SKILL.md') }])
    expect(deleteOpenCodeSkill('ship-check', testDir)).toBe(true)
    expect(listOpenCodeSkills(testDir)).toEqual([])
  })

  it('upserts and deletes OpenCode MCP server config entries', () => {
    const server = upsertOpenCodeMcp({ configDir: testDir, name: 'example', server: { type: 'local', command: ['node', 'server.js'], enabled: true } })

    expect(server).toMatchObject({ type: 'local', command: ['node', 'server.js'], enabled: true })
    expect(listOpenCodeMcp(testDir)).toHaveProperty('example')
    expect(deleteOpenCodeMcp('example', testDir)).toBe(true)
    expect(listOpenCodeMcp(testDir)).not.toHaveProperty('example')
  })

  it('upserts and deletes OpenCode custom tools under the local profile tools directory', () => {
    const tool = upsertOpenCodeTool({ configDir: testDir, name: 'lookup', extension: 'ts', content: 'export default { description: "Lookup", args: {}, async execute() { return "ok" } }' })

    expect(tool.path).toBe(path.join(testDir, 'tools', 'lookup.ts'))
    expect(listOpenCodeTools(testDir)).toEqual([{ name: 'lookup', path: tool.path }])
    expect(deleteOpenCodeTool('lookup', testDir)).toBe(true)
    expect(listOpenCodeTools(testDir)).toEqual([])
  })

  it('installs only Gateway base OpenCode assets', () => {
    const installed = installGatewayOpenCodeAssets(testDir)

    expect(installed).toEqual({
      mcp: 'gateway',
      agents: [...GATEWAY_AGENT_NAMES],
      skills: [...GATEWAY_SKILL_NAMES],
    })
    expect(Object.keys(listOpenCodeMcp(testDir))).toEqual(['gateway'])
    expect((listOpenCodeMcp(testDir) as Record<string, any>)['gateway'].environment).toMatchObject({
      GATEWAY_MCP_TOOLS: 'operate',
      OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE: path.join(testDir, 'gateway', 'http-admin-token'),
    })
    const agents = listOpenCodeAgents(testDir) as Record<string, any>
    expect(Object.keys(agents).sort()).toEqual(installed.agents.sort())
    expect(listOpenCodeSkills(testDir).map(skill => skill.name).sort()).toEqual(installed.skills.sort())
    expect(Object.keys(listOpenCodeMcp(testDir)).join(' ')).not.toMatch(/google|github|plaud|tavily/i)

    for (const agentName of GATEWAY_AGENT_NAMES) {
      expect(agents[agentName].tools).toMatchObject({
        read: true,
        skill: true,
        task: false,
        gateway_task_create: true,
        gateway_delegation_submit: true,
        gateway_project_status: true,
      })
      for (const toolName of GATEWAY_MCP_TOOL_NAMES) expect(agents[agentName].tools[toolName]).toBe(true)
    }
  })

  it('ships an OpenCode config template with the full Gateway team', () => {
    const template = fs.readFileSync(path.resolve('src/templates/opencode/opencode.jsonc'), 'utf-8')

    expect(template).toContain('"gateway"')
    for (const agent of GATEWAY_AGENT_NAMES) expect(template).toContain(`"${agent}"`)
    for (const skill of GATEWAY_SKILL_NAMES) expect(template).toContain(skill)
  })

  it('writes skills only under the local profile skills directory', () => {
    const outside = path.join(testDir, '..', 'outside-skills')
    fs.writeFileSync(path.join(testDir, 'opencode.jsonc'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', skills: { paths: [outside] } }, null, 2))

    const skill = upsertOpenCodeSkill({ configDir: testDir, name: 'safe-skill', content: '# Safe Skill' })

    expect(skill.path).toBe(path.join(testDir, 'skills', 'safe-skill', 'SKILL.md'))
    expect(fs.existsSync(path.join(outside, 'safe-skill', 'SKILL.md'))).toBe(false)
    expect(deleteOpenCodeSkill('safe-skill', testDir)).toBe(true)
  })

  it('rejects config directories outside an OpenCode profile allowlist', () => {
    const outside = path.join(testDir, 'not-an-opencode-profile')

    expect(() => listOpenCodeAgents(outside)).toThrow('configDir must be an OpenCode profile directory')
  })

  it('fails closed on invalid opencode.jsonc without overwriting it', () => {
    fs.writeFileSync(path.join(testDir, 'opencode.jsonc'), '{bad jsonc')

    expect(() => upsertOpenCodeAgent({ configDir: testDir, name: 'bad-write', model: 'openrouter/test-model' })).toThrow('OpenCode config is invalid')
    expect(fs.readFileSync(path.join(testDir, 'opencode.jsonc'), 'utf-8')).toBe('{bad jsonc')
  })

  it('parses JSONC without stripping comment-like text inside strings', () => {
    fs.writeFileSync(path.join(testDir, 'opencode.jsonc'), `{
      // profile comment
      "$schema": "https://example.com/schema//opencode",
      "agent": {
        "stringy": {
          "model": "openrouter/test-model",
          "prompt": "Keep https://example.com/a//b and /*not a comment*/ intact",
        },
      },
      "skills": { "paths": ["./skills"] }, /* trailing block comment */
    }`)

    const before = listOpenCodeAgents(testDir) as Record<string, any>
    expect(before['stringy'].prompt).toContain('https://example.com/a//b')
    expect(before['stringy'].prompt).toContain('/*not a comment*/')

    upsertOpenCodeAgent({ configDir: testDir, name: 'new-agent', model: 'openrouter/other-model' })

    const agents = listOpenCodeAgents(testDir) as Record<string, any>
    expect(agents['stringy'].prompt).toContain('/*not a comment*/')
    expect(agents).toHaveProperty('new-agent')
  })
})
