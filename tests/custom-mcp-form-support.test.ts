import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CustomSkillConfig } from '../packages/shared/src/index.ts'
import {
  buildCustomMcpDraft,
  collectCustomMcpIssues,
  createKeyValueDraft,
  createKeyValueDraftsFromRecord,
  linkedSkillNamesForMcp,
  nextSkillToolIdsForMcp,
  toggleStringSelection,
} from '../packages/app/src/components/plugins/custom-mcp-form-support.ts'

function makeSkill(name: string, toolIds: string[] = []): CustomSkillConfig {
  return {
    scope: 'machine',
    directory: null,
    name,
    content: `# ${name}`,
    files: [],
    toolIds,
  }
}

describe('createKeyValueDraftsFromRecord', () => {
  it('keeps one blank row for empty records and stable row ids for entries', () => {
    const empty = createKeyValueDraftsFromRecord()
    assert.equal(empty.length, 1)
    assert.equal(empty[0]?.key, '')
    assert.equal(empty[0]?.value, '')
    assert.match(empty[0]?.id || '', /^custom-mcp-field-/)

    const filled = createKeyValueDraftsFromRecord({ TOKEN: 'secret', REGION: 'eu' })
    assert.deepEqual(
      filled.map(({ key, value }) => ({ key, value })),
      [
        { key: 'TOKEN', value: 'secret' },
        { key: 'REGION', value: 'eu' },
      ],
    )
    assert.notEqual(filled[0]?.id, filled[1]?.id)
  })
})

describe('buildCustomMcpDraft', () => {
  it('normalizes stdio drafts without exposing project directories for machine scope', () => {
    const draft = buildCustomMcpDraft({
      scope: 'machine',
      projectTargetDirectory: '/ignored',
      name: ' github ',
      label: ' GitHub ',
      description: ' Developer platform ',
      traceLabel: ' repo action ',
      tracePluralLabel: ' repo actions ',
      type: 'stdio',
      command: ' npx ',
      args: ' -y   @modelcontextprotocol/server-github ',
      url: '',
      envPairs: [
        createKeyValueDraft(' GITHUB_TOKEN ', 'abc'),
        createKeyValueDraft('', 'ignored'),
      ],
      headerPairs: [createKeyValueDraft('Authorization', 'ignored')],
      googleAuthEnabled: true,
      authModeAvailable: true,
      allowPrivateNetwork: true,
      permissionMode: 'allow',
    })

    assert.equal(draft.scope, 'machine')
    assert.equal(draft.directory, null)
    assert.equal(draft.name, 'github')
    assert.equal(draft.label, 'GitHub')
    assert.equal(draft.description, 'Developer platform')
    assert.equal(draft.traceLabel, 'repo action')
    assert.equal(draft.tracePluralLabel, 'repo actions')
    assert.equal(draft.command, 'npx')
    assert.deepEqual(draft.args, ['-y', '@modelcontextprotocol/server-github'])
    assert.deepEqual(draft.env, { GITHUB_TOKEN: 'abc' })
    assert.equal(draft.googleAuth, true)
    assert.equal(draft.permissionMode, 'allow')
    assert.equal(draft.allowPrivateNetwork, undefined)
    assert.equal(draft.headers, undefined)
  })

  it('normalizes HTTP drafts with headers and private-network opt-in', () => {
    const draft = buildCustomMcpDraft({
      scope: 'project',
      projectTargetDirectory: '/repo',
      name: 'jira',
      label: '',
      description: '',
      type: 'http',
      command: 'ignored',
      args: 'ignored',
      url: ' https://mcp.example.test/sse ',
      envPairs: [createKeyValueDraft('IGNORED', 'yes')],
      headerPairs: [createKeyValueDraft(' Authorization ', 'Bearer token')],
      googleAuthEnabled: true,
      authModeAvailable: true,
      allowPrivateNetwork: true,
      permissionMode: 'ask',
    })

    assert.equal(draft.scope, 'project')
    assert.equal(draft.directory, '/repo')
    assert.equal(draft.label, undefined)
    assert.equal(draft.description, undefined)
    assert.equal(draft.url, 'https://mcp.example.test/sse')
    assert.deepEqual(draft.headers, { Authorization: 'Bearer token' })
    assert.equal(draft.allowPrivateNetwork, true)
    assert.equal(draft.command, undefined)
    assert.equal(draft.env, undefined)
    assert.equal(draft.googleAuth, undefined)
    assert.equal(draft.permissionMode, undefined)
  })
})

describe('collectCustomMcpIssues', () => {
  it('reports the same save blockers as the form', () => {
    const draft = buildCustomMcpDraft({
      scope: 'project',
      projectTargetDirectory: null,
      name: 'bad name',
      label: '',
      description: '',
      type: 'stdio',
      command: '',
      args: '',
      url: '',
      envPairs: [],
      headerPairs: [],
      googleAuthEnabled: false,
      authModeAvailable: false,
      allowPrivateNetwork: false,
      permissionMode: 'ask',
    })

    assert.deepEqual(collectCustomMcpIssues({
      draft,
      isEditing: false,
      existingNames: ['github'],
      scope: 'project',
      projectTargetDirectory: null,
      type: 'stdio',
    }), [
      'Use alphanumeric characters, hyphens, or underscores only for the MCP id.',
      'Choose a project directory for this project-scoped MCP.',
      'Add the stdio command that starts this MCP server.',
    ])
  })

  it('blocks duplicate names only while creating', () => {
    const draft = buildCustomMcpDraft({
      scope: 'machine',
      projectTargetDirectory: null,
      name: 'github',
      label: '',
      description: '',
      type: 'http',
      command: '',
      args: '',
      url: '',
      envPairs: [],
      headerPairs: [],
      googleAuthEnabled: false,
      authModeAvailable: false,
      allowPrivateNetwork: false,
      permissionMode: 'ask',
    })

    const createIssues = collectCustomMcpIssues({
      draft,
      isEditing: false,
      existingNames: ['github'],
      scope: 'machine',
      projectTargetDirectory: null,
      type: 'http',
    })
    assert.match(createIssues.join('\n'), /already exists/)

    const editIssues = collectCustomMcpIssues({
      draft,
      isEditing: true,
      existingNames: ['github'],
      scope: 'machine',
      projectTargetDirectory: null,
      type: 'http',
    })
    assert.doesNotMatch(editIssues.join('\n'), /already exists/)
  })
})

describe('skill link helpers', () => {
  it('derives linked skills and toggles selected names', () => {
    const skills = [
      makeSkill('research', ['github']),
      makeSkill('charts', ['other']),
      makeSkill('docs', ['github', 'other']),
    ]

    assert.deepEqual(linkedSkillNamesForMcp(skills, 'github'), ['research', 'docs'])
    assert.deepEqual(toggleStringSelection(['research'], 'charts'), ['research', 'charts'])
    assert.deepEqual(toggleStringSelection(['research', 'charts'], 'research'), ['charts'])
  })

  it('returns null when a skill toolIds list already matches the requested link state', () => {
    assert.equal(nextSkillToolIdsForMcp({
      currentToolIds: ['github'],
      mcpId: 'github',
      shouldBeLinked: true,
    }), null)
    assert.deepEqual(nextSkillToolIdsForMcp({
      currentToolIds: ['github', 'github', 'other'],
      mcpId: 'github',
      shouldBeLinked: true,
    }), null)
    assert.deepEqual(nextSkillToolIdsForMcp({
      currentToolIds: ['other'],
      mcpId: 'github',
      shouldBeLinked: true,
    }), ['other', 'github'])
    assert.deepEqual(nextSkillToolIdsForMcp({
      currentToolIds: ['github', 'other'],
      mcpId: 'github',
      shouldBeLinked: false,
    }), ['other'])
  })
})
