import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentVisualMap } from '../apps/desktop/src/renderer/components/chat/agent-visuals.ts'

test('buildAgentVisualMap preserves avatars and lets custom agents override runtime metadata', () => {
  const visuals = buildAgentVisualMap({
    runtimeAgents: [
      { name: 'data-analyst', color: 'info' },
      { name: 'research', color: 'warning' },
    ],
    builtinAgents: [
      {
        name: 'research',
        label: 'Research',
        source: 'open-cowork',
        mode: 'subagent',
        hidden: false,
        disabled: false,
        color: 'accent',
        description: 'Research',
        instructions: '',
        skills: [],
        toolAccess: [],
        nativeToolIds: [],
        configuredToolIds: [],
        avatar: null,
      },
    ],
    customAgents: [
      {
        scope: 'machine',
        directory: null,
        name: 'data-analyst',
        description: 'Analyze data',
        instructions: '',
        skillNames: [],
        toolIds: [],
        enabled: true,
        color: 'success',
        avatar: 'data:image/png;base64,FAKE',
        model: null,
        variant: null,
        temperature: null,
        top_p: null,
        steps: null,
        options: null,
        writeAccess: false,
        valid: true,
        issues: [],
      },
    ],
  })

  assert.deepEqual(visuals['data-analyst'], {
    avatar: 'data:image/png;base64,FAKE',
    color: 'success',
  })
  assert.deepEqual(visuals.research, {
    avatar: null,
    color: 'accent',
  })
})
