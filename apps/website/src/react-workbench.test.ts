import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  CloudApprovalsAndQuestions,
  CloudArtifactCards,
  CloudChatTimeline,
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
  ].join('\n')

  assert.match(html, /role="table"/)
  assert.match(html, /data-selected="true"/)
  assert.match(html, /Workspace summary for Cloud thread/)
  assert.match(html, /Runtime status/)
  assert.match(html, /Approval/)
  assert.match(html, /summary.txt/)
  assert.doesNotMatch(html, /signedUrl/)
  assert.doesNotMatch(html, /objectKey/)
  assert.doesNotMatch(html, /leaked-secret/)
})
