import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildReadableSkillMirrorRelativePath,
  buildRuntimeSkillContent,
} from '../apps/desktop/src/main/runtime-skill-catalog.ts'

test('buildReadableSkillMirrorRelativePath points into the project overlay skill mirror', () => {
  assert.equal(
    buildReadableSkillMirrorRelativePath('analyst', 'references/workflow.md'),
    '.opencowork/skill-bundles/analyst/references/workflow.md',
  )
})

test('buildRuntimeSkillContent advertises workspace-local bundle files and rewrites direct references', () => {
  const content = [
    '---',
    'name: analyst',
    '---',
    '',
    '# Analyst',
    '',
    'Read `references/workflow.md` first.',
    '',
    '## References',
    '- `assets/report-template.md`',
    '',
  ].join('\n')

  const files = [
    { path: 'references/workflow.md', content: '# workflow' },
    { path: 'assets/report-template.md', content: '# template' },
  ]

  const rewritten = buildRuntimeSkillContent('analyst', content, files)

  assert.match(rewritten, /## Open Cowork bundle files/)
  assert.match(rewritten, /`\.opencowork\/skill-bundles\/analyst\/references\/workflow\.md`/)
  assert.match(rewritten, /`\.opencowork\/skill-bundles\/analyst\/assets\/report-template\.md`/)
  assert.ok(!rewritten.includes('`references/workflow.md`'))
  assert.ok(!rewritten.includes('`assets/report-template.md`'))
})

test('buildRuntimeSkillContent rewrites stale shared-skill suffix paths to the local readable mirror', () => {
  const content = [
    '---',
    'name: analyst',
    '---',
    '',
    'Read `../../shared/analyst/references/workflow.md` first.',
    'Use `../../shared/analyst/assets/evidence-block.md` when writing the answer.',
    '',
  ].join('\n')

  const files = [
    { path: 'references/workflow.md', content: '# workflow' },
    { path: 'assets/evidence-block.md', content: '# evidence' },
  ]

  const rewritten = buildRuntimeSkillContent('analyst', content, files)

  assert.ok(!rewritten.includes('../../shared/analyst/references/workflow.md'))
  assert.ok(!rewritten.includes('../../shared/analyst/assets/evidence-block.md'))
  assert.match(rewritten, /`\.opencowork\/skill-bundles\/analyst\/references\/workflow\.md`/)
  assert.match(rewritten, /`\.opencowork\/skill-bundles\/analyst\/assets\/evidence-block\.md`/)
})
