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
  CloudSidebarThreadList,
  CloudThreadList,
} from './react-workbench.ts'
import { CLOUD_DELIVERABLE_APPROVAL_COPY, CloudConversationMeta } from './react-workbench-context.ts'
import { canManageCloudKnowledge, cloudKnowledgeAuthorityRole, knowledgeCaptureSpace } from './react-workbench-knowledge-state.ts'
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

test('React Cloud sidebar groups chats by project source', () => {
  const projectSession = makeSession(10)
  const projectFollowUp = makeSession(20)
  const chatOnlySession = makeSession(1)
  const sessions = [projectSession, projectFollowUp, chatOnlySession]
  const views = Object.fromEntries(sessions.map((session) => [session.sessionId, makeSessionView(session, 10, 0)]))

  const html = renderToStaticMarkup(createElement(CloudSidebarThreadList, {
    sessions,
    views,
    selectedSessionId: projectSession.sessionId,
  }))

  assert.match(html, /class="sidebar-thread-project"/)
  assert.match(html, /repo/)
  assert.match(html, />2<\/small>/)
  assert.match(html, /chat-only/)
  assert.match(html, />1<\/small>/)
  assert.match(html, /data-selected="true"/)
})

test('React Cloud sidebar groups chats from session list project metadata without loaded views', () => {
  const projectSession = {
    ...makeSession(10),
    projectSource: { kind: 'git' as const, repositoryUrl: 'https://github.com/acme/api.git' },
  }
  const projectFollowUp = {
    ...makeSession(20),
    projectSource: { kind: 'git' as const, repositoryUrl: 'https://github.com/acme/api.git' },
  }
  const chatOnlySession = makeSession(1)

  const html = renderToStaticMarkup(createElement(CloudSidebarThreadList, {
    sessions: [projectSession, projectFollowUp, chatOnlySession],
    views: {},
    selectedSessionId: projectSession.sessionId,
  }))

  assert.match(html, /api/)
  assert.match(html, />2<\/small>/)
  assert.match(html, /chat-only/)
  assert.match(html, />1<\/small>/)
  assert.match(html, /data-selected="true"/)
})

test('React Cloud sidebar keeps distinct repos with the same basename in separate groups', () => {
  const acmeSession = makeSession(10)
  const contosoSession = makeSession(20)
  const sessions = [acmeSession, contosoSession]
  const views = Object.fromEntries(sessions.map((session) => [session.sessionId, makeSessionView(session, 10, 0)]))
  views[acmeSession.sessionId].projection.view.projectSource = { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git' }
  views[contosoSession.sessionId].projection.view.projectSource = { kind: 'git', repositoryUrl: 'https://github.com/contoso/api.git' }

  const html = renderToStaticMarkup(createElement(CloudSidebarThreadList, {
    sessions,
    views,
  }))

  assert.equal(html.match(/class="sidebar-thread-project"/g)?.length, 2)
  assert.equal(html.match(/>1<\/small>/g)?.length, 2)
  assert.doesNotMatch(html, />2<\/small>/)
})

test('React workbench renders delegated handoff badges, task context, and approval-gated deliverables', () => {
  const session = makeSession(3)
  const view = makeSessionView(session, 10, 1)
  view.projection.view.taskRuns = [
    {
      id: 'task-root',
      title: 'Plan launch',
      agent: 'lead-agent',
      status: 'running',
      content: 'Planning the launch.',
      sourceSessionId: 'root-session',
      order: 3,
      toolCalls: [],
      todos: [],
      artifacts: [],
    },
    {
      id: 'task-child',
      title: 'Write launch notes',
      agent: 'writer-agent',
      status: 'completed',
      content: 'Drafted launch notes.',
      sourceSessionId: 'child-session',
      parentSessionId: 'root-session',
      order: 4,
      toolCalls: [],
      todos: [],
      artifacts: [],
    },
  ]

  const html = [
    renderToStaticMarkup(createElement(CloudChatTimeline, {
      view,
      handoffAgentBySessionId: { 'root-session': 'Lead Agent' },
    })),
    renderToStaticMarkup(createElement(CloudConversationMeta, {
      summary: 'default - 2 messages',
      taskContext: {
        projectId: 'project-1',
        projectTitle: 'Studio redesign',
        taskId: 'task-1',
        taskTitle: 'Conversation polish',
        taskStatus: 'running',
        taskColumn: 'doing',
        taskPriority: 'high',
        assignedSessionId: session.sessionId,
      },
    })),
    CLOUD_DELIVERABLE_APPROVAL_COPY,
  ].join('\n')

  assert.match(html, /from/)
  assert.match(html, /Lead Agent/)
  assert.match(html, /Project/)
  assert.match(html, /Studio redesign/)
  assert.match(html, /Conversation polish/)
  assert.match(html, /Nothing ships until you approve/)
  assert.doesNotMatch(html, /Capture to knowledge/)
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

test('React Cloud Knowledge capture ignores read-only spaces', () => {
  assert.equal(knowledgeCaptureSpace([
    {
      id: 'space-reader',
      name: 'Reader Space',
      visibility: 'company',
      role: 'Reader',
    },
  ]), null)

  assert.equal(knowledgeCaptureSpace([
    {
      id: 'space-reader',
      name: 'Reader Space',
      visibility: 'company',
      role: 'Reader',
    },
    {
      id: 'space-contributor',
      name: 'Contributor Space',
      visibility: 'team',
      role: 'Contributor',
    },
  ])?.id, 'space-contributor')
})

test('React Cloud Knowledge management follows owner and admin authority only', () => {
  assert.equal(cloudKnowledgeAuthorityRole('viewer', {
    principal: { role: 'admin' },
    member: { role: 'member' },
  }), 'admin')
  assert.equal(canManageCloudKnowledge('owner', null), true)
  assert.equal(canManageCloudKnowledge('member', { role: 'admin' }), true)
  assert.equal(canManageCloudKnowledge('admin', { role: 'member' }), false)
  assert.equal(canManageCloudKnowledge('viewer', { principal: { role: 'viewer' } }), false)
})
