import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  CloudApprovalsAndQuestions,
  CloudArtifactCards,
  CloudChatTimeline,
  CloudSelectedArtifactHistory,
  CloudRuntimeStatus,
  CloudThreadList,
} from './react-workbench.ts'
import { makeSession, makeSessionView } from './browser-test-fixtures.ts'

test('React workbench components render cloud-safe thread, timeline, runtime, and artifact markup', () => {
  const session = makeSession(1)
  const view = makeSessionView(session, 10, 1)
  const views = { [session.sessionId]: view }
  const html = [
    renderToStaticMarkup(createElement(CloudThreadList, { sessions: [session], views, selectedSessionId: session.sessionId })),
    renderToStaticMarkup(createElement(CloudChatTimeline, { view })),
    renderToStaticMarkup(createElement(CloudRuntimeStatus, { view })),
    renderToStaticMarkup(createElement(CloudApprovalsAndQuestions, { view })),
    renderToStaticMarkup(createElement(CloudArtifactCards, { view })),
    renderToStaticMarkup(createElement(CloudSelectedArtifactHistory, {
      view,
      indexedArtifacts: [{
        artifactId: 'artifact-index-1',
        filename: 'library-report.md',
        sessionId: 'session-library',
        kind: 'document',
        status: 'in-review',
        projectId: 'project-1',
      }],
    })),
  ].join('\n')

  assert.match(html, /role="table"/)
  assert.match(html, /data-selected="true"/)
  assert.match(html, /Workspace summary for Cloud thread/)
  assert.match(html, /Runtime status/)
  assert.match(html, /Coworker lanes 1/)
  assert.match(html, /class="studio-task-lane cloud-specialist-lane"/)
  assert.match(html, /data-session-id="session-1-child"/)
  assert.match(html, /Open coworker chat/)
  assert.match(html, /data-analyst/)
  assert.match(html, /Projected coworker work|Checked repository context/)
  assert.match(html, /Approval/)
  assert.match(html, /summary.txt/)
  assert.match(html, /library-report\.md/)
  assert.match(html, /data-session-id="session-library"/)
  assert.match(html, /in-review/)
  assert.doesNotMatch(html, /Cross-chat artifact browsing waits/)
  assert.doesNotMatch(html, /signedUrl/)
  assert.doesNotMatch(html, /objectKey/)
  assert.doesNotMatch(html, /leaked-secret/)
})

test('React workbench marks only post-prompt assistant messages as streaming', () => {
  const session = makeSession(2)
  const view = makeSessionView(session, 10, 0)
  view.projection.view.isGenerating = true
  view.projection.view.messages = [
    { id: 'user-1', role: 'user', content: 'First prompt', order: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'Finished answer', order: 2 },
    { id: 'user-2', role: 'user', content: 'Follow up', order: 3 },
  ]

  const waitingHtml = renderToStaticMarkup(createElement(CloudChatTimeline, { view }))
  assert.doesNotMatch(waitingHtml, /data-streaming="true"/)

  view.projection.view.messages.push({ id: 'assistant-2', role: 'assistant', content: 'Streaming answer', order: 4 })
  const streamingHtml = renderToStaticMarkup(createElement(CloudChatTimeline, { view }))
  assert.match(streamingHtml, /data-streaming="true"/)
  assert.match(streamingHtml, /Streaming answer/)
})
