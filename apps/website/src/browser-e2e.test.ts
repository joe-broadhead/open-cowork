import test from 'node:test'
import assert from 'node:assert/strict'
import { CLOUD_WEB_AUTH_REQUIRED_EVENT } from './app-api.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { createCloudWebBrowserHarness, waitFor } from './browser-test-harness.ts'

async function selectFirstCloudThread(harness: { document: Document }) {
  await waitFor(() => assert.ok(harness.document.querySelector('#sidebar-thread-list button')))
  ;(harness.document.querySelector('#sidebar-thread-list button') as HTMLButtonElement).click()
  await waitFor(() => assert.equal(harness.document.body.dataset.chatState, 'thread'))
}

async function readBrowserBlobText(harness: { window: { FileReader: typeof FileReader } }, blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new harness.window.FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result || '')))
    reader.addEventListener('error', () => reject(reader.error || new Error('download blob could not be read')))
    reader.readAsText(blob)
  })
}

function assertStreamAfterSequence(url: string, minimumSequence: number) {
  const after = new URL(url, 'https://cloud.example.test').searchParams.get('after')
  assert.ok(after)
  assert.ok(Number(after) >= minimumSequence, `expected stream cursor ${after} to be >= ${minimumSequence}`)
}

test('cloud web browser renders signed-out OIDC bootstrap state', async () => {
  const harness = await createCloudWebBrowserHarness({ signedOut: true }).start()
  try {
    assert.equal(harness.document.body.dataset.auth, 'signed-out')
    assert.equal(harness.document.querySelector('#status')?.textContent, 'Sign in required')
    assert.equal(harness.document.body.dataset.route, 'chat')
    assert.equal((harness.document.querySelector('[data-route-link="byok"]') as HTMLElement).hidden, true)
    assert.equal(harness.lastRequest((request) => request.path === '/auth/me')?.method, 'GET')
  } finally {
    harness.close()
  }
})

test('cloud web browser gates admin controls for member workspaces', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'member' }).start()
  try {
    assert.equal(harness.document.body.dataset.auth, 'signed-in')
    assert.equal(harness.document.querySelector('#role-name')?.textContent, 'member')
    assert.equal((harness.document.querySelector('#admin-notice') as HTMLElement).hidden, false)
    assert.equal((harness.document.querySelector('[data-route-link="byok"]') as HTMLElement).hidden, true)
    assert.equal((harness.document.querySelector('#byok-form input[name="providerId"]') as HTMLInputElement).disabled, true)
    assert.equal((harness.document.querySelector('#desktop-token') as HTMLButtonElement).disabled, true)
    assert.match((harness.document.querySelector('#desktop-token') as HTMLButtonElement).title, /Connection token issuance requires/)
    assert.match((harness.document.querySelector('#prepare-diagnostics') as HTMLButtonElement).title, /Diagnostics require/)
    assert.equal(harness.lastRequest((request) => request.path === '/api/workspace')?.method, 'GET')
    const requestedPaths = harness.requests.map((request) => request.path)
    for (const adminOnlyPath of [
      '/api/byok',
      '/api/api-tokens?limit=100',
      '/api/admin/members?limit=100',
      '/api/admin/audit?limit=100',
      '/api/admin/worker-pools?limit=100',
      '/api/admin/workers?limit=100',
      '/api/billing/subscription',
    ]) {
      assert.equal(requestedPaths.includes(adminOnlyPath), false, `${adminOnlyPath} is not fetched for member workspaces`)
    }
  } finally {
    harness.close()
  }
})

test('cloud web browser disables member invite controls outside invite signup mode', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin', signupMode: 'disabled' }).start()
  try {
    await waitFor(() => assert.match(harness.document.querySelector('#member-invite-notice')?.textContent || '', /only when signup mode is invite/))
    const email = harness.document.querySelector('#member-invite-form input[name="email"]') as HTMLInputElement
    const role = harness.document.querySelector('#member-invite-form select[name="role"]') as HTMLSelectElement
    const submit = harness.document.querySelector('#member-invite-form button[type="submit"]') as HTMLButtonElement
    await waitFor(() => assert.match(submit.title, /signup mode is invite/))
    assert.equal(email.disabled, true)
    assert.equal(role.disabled, true)
    assert.equal(submit.disabled, true)
    assert.match(submit.title, /signup mode is invite/)
    const makeAdmin = [...harness.document.querySelectorAll('#member-list button')]
      .find((button) => button.textContent === 'Make admin') as HTMLButtonElement
    assert.equal(makeAdmin.disabled, true)
    assert.match(makeAdmin.title, /signup mode is invite/)

    email.value = 'teammate@example.test'
    harness.submit('#member-invite-form')
    assert.equal(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/admin/members'), undefined)
    assert.match(harness.document.querySelector('#status')?.textContent || '', /signup mode is invite/)
  } finally {
    harness.close()
  }
})

test('cloud web browser keeps disabled member role controls locked', async () => {
  const harness = createCloudWebBrowserHarness({ role: 'admin', memberCount: 6 })
  harness.state.members = harness.state.members.map((member: Record<string, unknown>) => {
    if (member.accountId === 'acct-2') return { ...member, role: 'member', status: 'disabled' }
    if (member.accountId === 'acct-6') return { ...member, role: 'admin', status: 'disabled' }
    return member
  })
  await harness.start()
  try {
    const rows = [...harness.document.querySelectorAll('#member-list .member-row')]
    const disabledMemberRow = rows.find((row) => row.textContent?.includes('member@example.test'))
    const disabledAdminRow = rows.find((row) => row.textContent?.includes('member-6@example.test'))
    assert.ok(disabledMemberRow)
    assert.ok(disabledAdminRow)

    const buttonIn = (row: Element, label: string) => [...row.querySelectorAll('button')]
      .find((button) => button.textContent === label) as HTMLButtonElement
    const makeAdmin = buttonIn(disabledMemberRow, 'Make admin')
    const makeMember = buttonIn(disabledAdminRow, 'Make member')
    assert.equal(makeAdmin.disabled, true)
    assert.equal(makeMember.disabled, true)

    makeAdmin.click()
    makeMember.click()
    assert.equal(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/admin/members/acct-2/update'), undefined)
    assert.equal(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/admin/members/acct-6/update'), undefined)
  } finally {
    harness.close()
  }
})

test('cloud web browser exercises every route declared in the route API matrix', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))
    assert.ok(Array.isArray(harness.bootstrap.adminSurfaces))
    const adminNav = harness.document.querySelector('[data-admin-nav]') as HTMLDetailsElement | null
    assert.equal(adminNav?.open, false)

    for (const entry of CLOUD_WEB_ROUTE_API_MATRIX) {
      const link = harness.document.querySelector(`[data-route-link="${entry.routeId}"]`) as HTMLElement | null
      const panel = harness.document.querySelector(`[data-route-panel="${entry.routeId}"]`) as HTMLElement | null
      assert.ok(link, `${entry.routeId} route link exists`)
      assert.ok(panel, `${entry.routeId} route panel exists`)
      assert.equal(link.hidden, false, `${entry.routeId} route link is visible to admins`)

      link.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await waitFor(() => {
        assert.equal(harness.document.body.dataset.route, entry.routeId)
        assert.equal(panel.getAttribute('aria-hidden'), 'false')
      })
      assert.equal(adminNav?.open, entry.surface === 'admin')
      if (entry.surface === 'admin') {
        const surface = panel.querySelector(`[data-admin-surface-route="${entry.routeId}"]`)
        assert.ok(surface, `${entry.routeId} renders an admin surface contract card`)
      }
    }
  } finally {
    harness.close()
  }
})

test('cloud web browser exposes desktop parity boundaries and workbench state vocabulary', async () => {
  const harness = createCloudWebBrowserHarness({ role: 'admin' })
  const firstView = harness.views[harness.sessions[0].sessionId]
  firstView.projection.view.messages.push(
    { id: 'system-note', role: 'system', content: 'Cloud policy loaded.', order: 8 },
    { id: 'error-note', role: 'error', content: 'Provider warning projected from cloud.', order: 9 },
  )
  await harness.start()
  try {
    assert.ok(Array.isArray(harness.bootstrap.workbenchParity))
    assert.match(harness.document.querySelector('[data-parity-route="threads"]')?.textContent || '', /Cloud Project Sources/)
    assert.match(harness.document.querySelector('[data-parity-route="threads"]')?.textContent || '', /Objectives/)
    assert.match(harness.document.querySelector('[data-parity-route="threads"]')?.textContent || '', /Local Filesystem/)
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Studio parity launch/)
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Plan with Cleo/)

    const chatLink = harness.document.querySelector('[data-route-link="chat"]') as HTMLAnchorElement
    chatLink.focus()
    assert.equal(harness.document.activeElement, chatLink)
    chatLink.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'chat'))
    assert.match(harness.document.querySelector('[data-parity-route="chat"]')?.textContent || '', /Runtime Status/)
    assert.match(harness.document.querySelector('[data-parity-route="chat"]')?.textContent || '', /Approvals & Questions/)
    assert.equal(harness.document.body.dataset.chatState, 'empty')
    assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/)
    assert.equal((harness.document.querySelector('#chat-inspector') as HTMLElement).hidden, true)
    await selectFirstCloudThread(harness)
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Review Cloud API writes/)
    const workbench = harness.document.querySelector('.cloud-chat-workbench') as HTMLElement
    assert.ok(harness.document.querySelector('[data-workbench-pane="threads"]'))
    assert.ok(harness.document.querySelector('[data-workbench-layout="true"]'))
    assert.ok(harness.document.querySelector('[data-workbench-pane="conversation"]'))
    assert.ok(harness.document.querySelector('[data-workbench-pane="review"]'))
    assert.equal(workbench.dataset.reviewOpen, 'false')
    assert.equal(workbench.classList.contains('ui-workbench-layout--with-review'), false)
    assert.ok(harness.document.querySelector('[data-action-cluster="true"]'))
    assert.ok(harness.document.querySelector('#chat-inspector-detail [data-diff-view="true"], #chat-inspector-detail[data-diff-view="true"]'))
    assert.match(harness.document.querySelector('.message-bubble[data-role="system"]')?.textContent || '', /Cloud policy loaded/)
    assert.match(harness.document.querySelector('.message-bubble[data-role="error"]')?.textContent || '', /Provider warning/)

    const inspector = harness.document.querySelector('#chat-inspector') as HTMLElement
    const inspectorToggle = harness.document.querySelector('#chat-inspector-toggle') as HTMLButtonElement
    inspectorToggle.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => {
      assert.equal(inspector.hidden, false)
      assert.equal(workbench.dataset.reviewOpen, 'true')
      assert.equal(workbench.classList.contains('ui-workbench-layout--with-review'), true)
      assert.equal(inspectorToggle.getAttribute('aria-expanded'), 'true')
    })
    ;(harness.document.querySelector('#chat-inspector-close') as HTMLButtonElement)
      .dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => {
      assert.equal(inspector.hidden, true)
      assert.equal(workbench.dataset.reviewOpen, 'false')
      assert.equal(workbench.classList.contains('ui-workbench-layout--with-review'), false)
      assert.equal(inspectorToggle.getAttribute('aria-expanded'), 'false')
    })

    harness.clickText('[data-route-link]', 'Coworkers')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'agents'))
    assert.ok(harness.document.querySelector('#workbench-agent-list .agent-card'))
    assert.equal(harness.document.querySelector('#workbench-agent-list > .row'), null)

    harness.clickText('[data-route-link]', 'Tools & Skills')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'capabilities'))
    assert.match(harness.document.querySelector('[data-parity-route="capabilities"]')?.textContent || '', /Local Stdio MCPs/)
    assert.ok(harness.document.querySelector('#tool-list .capability-card'))
    assert.ok(harness.document.querySelector('#skill-list .capability-card'))
    assert.equal(harness.document.querySelector('#tool-list > .row'), null)
    assert.match(harness.document.querySelector('#capability-policy-note')?.textContent || '', /Local stdio MCPs are Desktop-only/)

    harness.clickText('[data-route-link]', 'Playbooks')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'workflows'))
    assert.match(harness.document.querySelector('#workflow-detail')?.textContent || '', /Latest run/)
    const workflowForm = harness.document.querySelector('#workflow-form') as HTMLFormElement
    ;(workflowForm.elements.namedItem('title') as HTMLInputElement).value = 'Daily triage'
    ;(workflowForm.elements.namedItem('agentName') as HTMLInputElement).value = 'data-analyst'
    ;(workflowForm.elements.namedItem('triggerType') as HTMLSelectElement).value = 'schedule'
    ;(workflowForm.elements.namedItem('toolIds') as HTMLInputElement).value = 'shell'
    ;(workflowForm.elements.namedItem('skillNames') as HTMLInputElement).value = 'analysis'
    ;(workflowForm.elements.namedItem('instructions') as HTMLTextAreaElement).value = 'Summarize the day.'
    harness.submit('#workflow-form')
    const isWorkflowCreateRequest = (request: { method: string, path: string }) => (
      request.method === 'POST' && request.path.startsWith('/api/workflows')
    )
    await waitFor(() => assert.ok(harness.lastRequest(isWorkflowCreateRequest)))
    const createdWorkflowRequest = harness.lastRequest(isWorkflowCreateRequest)
    const createdWorkflowBody = createdWorkflowRequest?.body as Record<string, unknown>
    assert.equal(createdWorkflowBody.triggerType, undefined)
    assert.deepEqual(createdWorkflowBody.triggers, [{
      id: 'schedule-web',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 9,
        runAtMinute: 0,
      },
    }])
    await waitFor(() => assert.match(harness.document.querySelector('#status')?.textContent || '', /Playbook created/))

    harness.clickText('[data-route-link]', 'Channels')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'channels'))
    assert.match(harness.document.querySelector('[data-parity-route="channels"]')?.textContent || '', /channel reach|delivery status|linked chats/i)
    assert.match(harness.document.querySelector('#channel-summary-list')?.textContent || '', /read-only/)
    assert.doesNotMatch(harness.document.querySelector('#channel-summary-list')?.textContent || '', /credentials|dead-letter|retries/i)
    assert.ok(harness.document.querySelector('#channel-agent-list .row'))
    assert.ok(harness.document.querySelector('#channel-binding-list .row'))
    assert.ok(harness.document.querySelector('#channel-delivery-list .row'))
    const userDeliveryText = harness.document.querySelector('#channel-delivery-list')?.textContent || ''
    assert.doesNotMatch(userDeliveryText, /leaked-secret|signed\?token=|secret:\/\//)
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/agents?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/bindings?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/deliveries?limit=50'))
  } finally {
    harness.close()
  }

  const locked = await createCloudWebBrowserHarness({
    role: 'admin',
    features: { chat: false, workflows: false, agents: false },
  }).start()
  try {
    const startThread = locked.document.querySelector('#workbench-agent-list button.primary') as HTMLButtonElement
    assert.equal(startThread.disabled, true)
    assert.match(startThread.title, /Start chat disables/)
    const runNow = locked.document.querySelector('#workflow-detail button.primary') as HTMLButtonElement
    assert.equal(runNow.disabled, true)
    assert.match(runNow.title, /Playbook controls disable/)
    const workflowSubmit = locked.document.querySelector('#workflow-form button[type="submit"]') as HTMLButtonElement
    assert.equal(workflowSubmit.disabled, true)
    assert.match(workflowSubmit.title, /Playbook controls are disabled/)
    locked.submit('#workflow-form')
    assert.equal(locked.lastRequest((request) => request.method === 'POST' && request.path === '/api/workflows'), undefined)
    assert.match(locked.document.querySelector('#status')?.textContent || '', /Playbook controls are disabled/)
  } finally {
    locked.close()
  }
})

test('cloud web browser renders and mutates the Projects Kanban board through coordination APIs', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Studio parity launch/))
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Backlog/)
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /In progress/)
    assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Audit project surface parity/)

    const boardSurface = harness.document.querySelector('#project-board-surface') as HTMLElement
    const planButton = Array.from(boardSurface.querySelectorAll('.studio-project-board-header__actions button')) as HTMLButtonElement[]
    const headerPlanButton = planButton.find((button) => button.textContent?.trim() === 'Plan with Cleo')
    assert.ok(headerPlanButton)
    headerPlanButton.click()
    await waitFor(() => assert.ok(harness.document.querySelector('.studio-plan-form')))
    harness.submit('.studio-plan-form')
    await waitFor(() => {
      assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/api\/coordination\/projects\/project-1\/plan-with-cleo$/.test(request.path)))
      assert.match(harness.document.querySelector('#project-board-surface')?.textContent || '', /Clarify acceptance criteria/)
    })

    const taskButtons = Array.from(harness.document.querySelectorAll('.studio-kanban-task-button')) as HTMLButtonElement[]
    const reviewTask = taskButtons
      .find((button) => button.textContent?.includes('Review Cloud API writes'))
    assert.ok(reviewTask)
    reviewTask.click()
    await waitFor(() => assert.match(harness.document.querySelector('.studio-task-drawer')?.textContent || '', /Review Cloud API writes/))
    const doneStageButtons = Array.from(harness.document.querySelectorAll('.studio-stage-chips button')) as HTMLButtonElement[]
    const doneStage = doneStageButtons
      .find((button) => button.textContent?.trim() === 'Done')
    assert.ok(doneStage)
    doneStage.click()
    await waitFor(() => {
      const move = harness.lastRequest((request) => request.method === 'POST' && /\/api\/coordination\/tasks\/task-3\/move$/.test(request.path))
      assert.equal((move?.body as Record<string, unknown>)?.column, 'done')
    })

    const assignee = harness.document.querySelector('.studio-select-row select') as HTMLSelectElement
    assignee.value = 'data-analyst'
    assignee.dispatchEvent(new harness.window.Event('change', { bubbles: true }))
    await waitFor(() => {
      const assign = harness.lastRequest((request) => request.method === 'POST' && /\/api\/coordination\/tasks\/task-3\/assign$/.test(request.path))
      assert.equal((assign?.body as Record<string, unknown>)?.assigneeAgent, 'data-analyst')
    })

    const refreshedTaskButtons = Array.from(harness.document.querySelectorAll('.studio-kanban-task-button')) as HTMLButtonElement[]
    const linkedTask = refreshedTaskButtons
      .find((button) => button.textContent?.includes('Audit project surface parity'))
    assert.ok(linkedTask)
    linkedTask.click()
    await waitFor(() => assert.match(harness.document.querySelector('.studio-task-drawer')?.textContent || '', /Audit project surface parity/))
    harness.clickText('button', 'Open the work')
    await waitFor(() => {
      assert.ok(harness.lastRequest((request) => request.method === 'GET' && /\/api\/coordination\/tasks\/task-1\/work-target$/.test(request.path)))
      assert.equal(harness.document.body.dataset.route, 'chat')
    })
  } finally {
    harness.close()
  }
})

test('cloud web browser clears signed-in UI when AppAPI reports auth required after hydration', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    harness.window.dispatchEvent(new harness.window.CustomEvent(CLOUD_WEB_AUTH_REQUIRED_EVENT))
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.auth, 'signed-out')
      assert.equal(harness.document.body.dataset.route, 'chat')
      assert.equal(harness.document.querySelector('[data-route-panel="chat"]')?.getAttribute('aria-hidden'), 'false')
      assert.equal(harness.document.querySelector('[data-route-panel="org"]')?.getAttribute('aria-hidden'), 'true')
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/)
      assert.ok(harness.document.querySelector('#prompt-form textarea[name="text"]'))
    })
    assert.match(harness.document.querySelector('#status')?.textContent || '', /Sign in required/)
  } finally {
    harness.close()
  }
})

test('cloud web browser renders launchpad feed and routes launchpad actions', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  const clickContaining = (selector: string, text: string) => {
    const target = [...harness.document.querySelectorAll(selector)]
      .find((element) => element.textContent?.includes(text)) as HTMLElement | undefined
    assert.ok(target, `${selector} containing ${text} exists`)
    target.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  try {
    await waitFor(() => assert.match(harness.document.querySelector('#cloud-launchpad-home')?.textContent || '', /Implement cloud launchpad/))
    assert.match(harness.document.querySelector('#cloud-launchpad-home')?.textContent || '', /Run read-only tests/)
    assert.match(harness.document.querySelector('#cloud-launchpad-home')?.textContent || '', /summary.txt/)
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/launchpad/feed?limit=3'))
    const openChatRoute = () => {
      const chatLink = harness.document.querySelector('[data-route-link="chat"]') as HTMLElement | null
      assert.ok(chatLink, 'chat route link exists')
      chatLink.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    }

    clickContaining('.cloud-launchpad-suggestion', 'Create a workflow')
    await waitFor(() => {
      assert.equal((harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value, 'Help me turn a repeated task into a saved workflow.')
      assert.equal((harness.document.querySelector('#composer-agent') as HTMLSelectElement).value, 'chief-of-staff')
    })

    clickContaining('.cloud-launchpad-team-strip', 'Your team')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'agents'))

    openChatRoute()
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'chat'))
    clickContaining('.cloud-launchpad-motion-row', 'summary.txt')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'artifacts'))
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path.startsWith('/api/sessions/session-1/artifacts')))

    openChatRoute()
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'chat'))
    clickContaining('.cloud-launchpad-motion-row', 'Implement cloud launchpad')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.chatState, 'thread')
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1/)
    })
  } finally {
    harness.close()
  }
})

test('cloud launchpad suggestions stay inside the allowed coworker policy', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin', allowedAgents: ['build'] }).start()
  const clickContaining = (selector: string, text: string) => {
    const target = [...harness.document.querySelectorAll(selector)]
      .find((element) => element.textContent?.includes(text)) as HTMLElement | undefined
    assert.ok(target, `${selector} containing ${text} exists`)
    target.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  try {
    await waitFor(() => assert.match(harness.document.querySelector('#cloud-launchpad-home')?.textContent || '', /Plan a release/))

    clickContaining('.cloud-launchpad-suggestion', 'Plan a release')
    await waitFor(() => {
      assert.equal((harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value, 'Draft a release plan for the next milestone.')
      assert.equal((harness.document.querySelector('#composer-agent') as HTMLSelectElement).value, 'build')
    })

    clickContaining('.cloud-launchpad-suggestion', 'Create a workflow')
    await waitFor(() => {
      assert.equal((harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value, 'Help me turn a repeated task into a saved workflow.')
      assert.equal((harness.document.querySelector('#composer-agent') as HTMLSelectElement).value, 'build')
    })
  } finally {
    harness.close()
  }
})

test('cloud launchpad suggestions preserve requested agents for default cloud policies', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin', allowedAgents: null }).start()
  const clickContaining = (selector: string, text: string) => {
    const target = [...harness.document.querySelectorAll(selector)]
      .find((element) => element.textContent?.includes(text)) as HTMLElement | undefined
    assert.ok(target, `${selector} containing ${text} exists`)
    target.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  try {
    await waitFor(() => assert.match(harness.document.querySelector('#cloud-launchpad-home')?.textContent || '', /Create a workflow/))
    clickContaining('.cloud-launchpad-suggestion', 'Create a workflow')
    await waitFor(() => {
      assert.equal((harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value, 'Help me turn a repeated task into a saved workflow.')
      assert.match(harness.document.querySelector('.composer-lead-row')?.textContent || '', /chief-of-staff/)
    })

    harness.submit('#prompt-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/prompt$/.test(request.path))))
    const promptRequest = harness.lastRequest((request) => request.method === 'POST' && /\/prompt$/.test(request.path))
    assert.equal((promptRequest?.body as Record<string, unknown>).agent, 'chief-of-staff')
  } finally {
    harness.close()
  }
})

test('cloud web browser creates, prompts, streams, reloads, and continues a cloud thread', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1/))
    assert.equal(harness.document.body.dataset.chatState, 'empty')
    assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/)
    assert.equal((harness.document.querySelector('#chat-timeline') as HTMLElement).hidden, true)
    assert.equal((harness.document.querySelector('#chat-inspector') as HTMLElement).hidden, true)

    harness.clickText('button', 'New chat')
    await waitFor(() => {
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/)
      assert.equal((harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).disabled, false)
    })
    const agent = harness.document.querySelector('#composer-agent') as HTMLSelectElement
    await waitFor(() => assert.match(agent.textContent || '', /build/))
    await waitFor(() => assert.match(harness.document.querySelector('#composer-agent-chips')?.textContent || '', /build/))
    harness.clickText('#composer-agent-chips button', '@build')
    assert.equal(agent.value, 'build')
    await waitFor(() => assert.match(harness.document.querySelector('.composer-lead-row')?.textContent || '', /Assign to: build/))
    const message = harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement
    await waitFor(() => assert.match(message.value, /^@build/))
    assert.equal((harness.document.querySelector('#prompt-form .composer-send') as HTMLButtonElement).disabled, true)
    const setTextareaValue = Object.getOwnPropertyDescriptor(harness.window.HTMLTextAreaElement.prototype, 'value')?.set
    setTextareaValue?.call(message, 'Continue the work.')
    message.dispatchEvent(new harness.window.Event('input', { bubbles: true, cancelable: true }))
    await waitFor(() => assert.equal((harness.document.querySelector('#prompt-form .composer-send') as HTMLButtonElement).disabled, false))
    harness.submit('#prompt-form')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Created browser thread/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/sessions'))
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Live answer from cloud/))
    const promptRequest = harness.lastRequest((request) => request.method === 'POST' && /\/prompt$/.test(request.path))
    assert.ok(promptRequest)
    assert.equal((promptRequest.body as Record<string, unknown>).agent, 'build')
    assert.equal((promptRequest.body as Record<string, unknown>).text, 'Continue the work.')

    const sessionId = harness.sessions[0].sessionId
    const liveStreamAfterSequence = harness.views[sessionId].projection.sequence
    harness.views[sessionId].projection.view.messages.push({ id: 'live-update', role: 'assistant', content: 'SSE live update arrived.', order: 30 })
    harness.views[sessionId].projection.sequence += 1
    let sessionSource = harness.eventSources.find((source) => source.url.includes(`/api/sessions/${sessionId}/events`))
    await waitFor(() => {
      sessionSource = harness.eventSources.find((source) => source.url.includes(`/api/sessions/${sessionId}/events`))
      assert.ok(sessionSource)
    })
    assertStreamAfterSequence(sessionSource!.url, liveStreamAfterSequence)
    sessionSource!.emit('assistant.message', { type: 'assistant.message', sessionId, sequence: harness.views[sessionId].projection.sequence })
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /SSE live update arrived/))

    const reloaded = createCloudWebBrowserHarness({ role: 'admin' })
    try {
      reloaded.sessions.splice(0, reloaded.sessions.length, ...harness.sessions)
      Object.assign(reloaded.views, harness.views)
      await reloaded.start()
      await waitFor(() => assert.equal(reloaded.document.body.dataset.auth, 'signed-in'))
      await selectFirstCloudThread(reloaded)
      await waitFor(() => assert.match(reloaded.document.querySelector('#chat-timeline')?.textContent || '', /SSE live update arrived/))
      await waitFor(() => {
        const reloadedSource = reloaded.eventSources.find((source) => source.url.includes(`/api/sessions/${sessionId}/events`))
        assert.ok(reloadedSource)
        assertStreamAfterSequence(reloadedSource.url, reloaded.views[sessionId].projection.sequence)
      })
    } finally {
      reloaded.close()
    }
  } finally {
    harness.close()
  }
})

test('cloud web browser starts project-backed chats from Projects route sources', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    const repositoryUrl = harness.document.querySelector('#session-form input[name="repositoryUrl"]') as HTMLInputElement
    const ref = harness.document.querySelector('#session-form input[name="ref"]') as HTMLInputElement
    const subdirectory = harness.document.querySelector('#session-form input[name="subdirectory"]') as HTMLInputElement
    repositoryUrl.value = 'https://github.com/joe-broadhead/open-cowork.git'
    ref.value = 'master'
    subdirectory.value = 'apps/website'

    harness.submit('#session-form')

    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/project-sources/validate')))
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/sessions')))
    const sessionRequest = harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/sessions')
    assert.deepEqual(sessionRequest?.body, {
      profileName: 'default',
      projectSource: {
        kind: 'git',
        repositoryUrl: 'https://github.com/joe-broadhead/open-cowork.git',
        ref: 'master',
        subdirectory: 'apps/website',
        credentialRef: null,
      },
    })
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'chat'))
    assert.match(harness.document.querySelector('#status')?.textContent || '', /Chat started/)
  } finally {
    harness.close()
  }
})

test('cloud web browser keeps project-source policy denials in Projects route', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin', projectSourceDenied: true }).start()
  try {
    const repositoryUrl = harness.document.querySelector('#session-form input[name="repositoryUrl"]') as HTMLInputElement
    repositoryUrl.value = 'https://blocked.example/repo.git'

    harness.submit('#session-form')

    await waitFor(() => assert.match(harness.document.querySelector('#status')?.textContent || '', /blocked by policy/i))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/project-sources/validate'))
    assert.equal(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/sessions'), undefined)
  } finally {
    harness.close()
  }
})

test('cloud web browser pages cloud threads through backend cursors without losing loaded pages on SSE', async () => {
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    sessionCount: 1001,
    hydratedViewCount: 1,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, 200))
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/sessions?limit=200'))

    const loadMore = harness.document.querySelector('#thread-load-more') as HTMLButtonElement
    for (const expected of [400, 600, 800, 1000]) {
      loadMore.click()
      await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, expected))
    }
    assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1000/)
    assert.match(harness.document.querySelector('#thread-limit-status')?.textContent || '', /1000 of 1000 loaded of about 1001 total/)
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path.includes('cursor=offset%3A800')))
    assert.equal((loadMore as HTMLElement).hidden, false)

    const laterPageRow = [...harness.document.querySelectorAll('#thread-list [role="row"]')]
      .find((row) => row.textContent?.includes('Cloud thread 1000'))
    assert.ok(laterPageRow)
    ;(laterPageRow.querySelector('button') as HTMLButtonElement).click()
    await waitFor(() => assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1000/))

    const workspaceSource = harness.eventSources.find((source) => source.url === '/api/events')
    assert.ok(workspaceSource)
    workspaceSource.emit('snapshot.required', { type: 'snapshot.required', sequence: 0 })
    await waitFor(() => {
      const rows = [...harness.document.querySelectorAll('#thread-list [role="row"]')]
      assert.equal(rows.length, 1000)
      assert.equal(new Set(rows.map((row) => row.textContent || '')).size, rows.length)
      assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1000/)
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1000/)
      assert.match(harness.document.querySelector('#thread-list [data-selected="true"]')?.textContent || '', /Cloud thread 1000/)
      assert.equal((loadMore as HTMLElement).hidden, false)
    })
  } finally {
    harness.close()
  }
})

test('cloud web browser bounds large admin surfaces and redacts unsafe operational details', async () => {
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    memberCount: 150,
    tokenCount: 140,
    deliveryCount: 80,
    workflowCount: 140,
    workerCount: 120,
    auditCount: 130,
    usageCount: 40,
    artifactCount: 140,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))
    await selectFirstCloudThread(harness)

    assert.equal(harness.document.querySelectorAll('#member-list .member-row').length, 100)
    assert.equal(harness.document.querySelectorAll('#token-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#delivery-list > .row').length, 50)
    assert.equal(harness.document.querySelectorAll('#channel-delivery-list > .row').length, 50)
    assert.equal(harness.document.querySelectorAll('#workflow-list [role="row"]').length, 100)
    assert.equal(harness.document.querySelectorAll('#audit-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#artifact-list .artifact-card').length, 100)
    assert.ok(harness.document.querySelectorAll('#usage-list > .row').length <= 12)
    assert.ok(harness.document.querySelectorAll('#admin-worker-summary > .row').length <= 11)

    assert.ok(harness.lastRequest((request) => request.path === '/api/admin/members?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/api-tokens?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/agents?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/bindings?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/deliveries?limit=50'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/workflows?limit=100'))

    const auditText = harness.document.querySelector('#audit-list')?.textContent || ''
    assert.doesNotMatch(auditText, /leaked-secret|signed\?token=/)
    assert.match(auditText, /\[redacted\]/)

    const deliveryText = harness.document.querySelector('#delivery-list')?.textContent || ''
    assert.doesNotMatch(deliveryText, /leaked-secret|signed\?token=/)
    const channelDeliveryText = harness.document.querySelector('#channel-delivery-list')?.textContent || ''
    assert.doesNotMatch(channelDeliveryText, /leaked-secret|signed\?token=|secret:\/\//)

    const artifactText = harness.document.querySelector('#artifact-list')?.textContent || ''
    assert.doesNotMatch(artifactText, /signed\?token=|objectKey/)

    harness.clickText('#diagnostics button', 'Prepare bundle')
    await waitFor(() => assert.match(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /secrets-redacted/))
    assert.doesNotMatch(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /leaked-secret|signed\?token=/)

    const blobs = new Map<string, Blob>()
    const downloads: Array<{ download: string, href: string }> = []
    Object.defineProperty(harness.window.URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        const href = `blob:https://cloud.example.test/diagnostics-${blobs.size}`
        blobs.set(href, blob)
        return href
      },
    })
    harness.document.addEventListener('click', (event: Event) => {
      const link = (event.target as Element | null)?.closest?.('a') as HTMLAnchorElement | null
      if (link?.download) downloads.push({ download: link.download, href: link.href })
    }, true)
    harness.clickText('#diagnostics-bundle button', 'Download bundle')
    await waitFor(() => assert.equal(downloads.length, 1))
    assert.equal(downloads[0]?.download, 'open-cowork-diagnostics.json')
    const downloadedBlob = blobs.get(downloads[0]?.href || '')
    assert.ok(downloadedBlob)
    const downloaded = await new Promise<string>((resolve, reject) => {
      const reader = new harness.window.FileReader()
      reader.addEventListener('load', () => resolve(String(reader.result || '')))
      reader.addEventListener('error', () => reject(reader.error || new Error('diagnostics download could not be read')))
      reader.readAsText(downloadedBlob)
    })
    assert.match(downloaded || '', /secrets-redacted/)
    assert.doesNotMatch(downloaded || '', /leaked-secret|signed\?token=/)
  } finally {
    harness.close()
  }
})

test('cloud web browser handles approvals, questions, artifacts, and workflow runs', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    const firstSessionId = harness.sessions[0].sessionId
    harness.views[firstSessionId].projection.view.lastError = 'Provider timeout while summarizing the run.'
    await selectFirstCloudThread(harness)
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Run read-only tests/))
    const reviewText = harness.document.querySelector('#chat-inspector')?.textContent || ''
    assert.match(reviewText, /Review queue/)
    assert.match(reviewText, /Follow-up/)
    assert.match(reviewText, /Verify browser workbench/)
    assert.match(reviewText, /approval\/question/)
    assert.match(reviewText, /1 runtime issue/)
    assert.doesNotMatch(reviewText, /task-signed|objectKey|leaked-secret/)
    assert.equal(harness.lastRequest((request) => request.method === 'GET' && /\/api\/artifacts(?:\?|$)/.test(request.path)), undefined)

    harness.clickText('.runtime-card[data-kind="approval"] button', 'Allow')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /approved/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /permission-respond$/.test(request.path)))

    const answer = harness.document.querySelector('[data-question-answer]') as HTMLTextAreaElement
    answer.value = 'Yes'
    harness.clickText('.runtime-card[data-kind="question"] button', 'Send answer')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /answered/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /question-reply$/.test(request.path)))

    harness.clickText('.artifact-card button', 'Inspect')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.route, 'artifacts')
      assert.match(harness.document.querySelector('#artifact-detail')?.textContent || '', /Artifact metadata/)
      assert.ok(harness.document.querySelector('#artifact-detail [data-diff-view="true"], #artifact-detail[data-diff-view="true"]'))
      assert.match(harness.document.querySelector('#artifact-history')?.textContent || '', /summary\.txt/)
      assert.doesNotMatch(harness.document.querySelector('#artifact-history')?.textContent || '', /Cross-chat artifact browsing waits/)
    })
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && /\/artifacts(?:\?|$)/.test(request.path)))

    harness.clickText('.artifact-card button', 'Download')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'GET' && /\/artifacts\/session-1-artifact$/.test(request.path))))

    harness.clickText('[data-route-link]', 'Playbooks')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'workflows'))
    harness.clickText('#workflow-detail button', 'Run now')
    await waitFor(() => {
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Workflow run thread/)
      assert.equal(harness.document.body.dataset.route, 'chat')
    })
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/api\/workflows\/workflow-1\/run$/.test(request.path)))
  } finally {
    harness.close()
  }
})

test('cloud web browser exercises BYOK, gateway, billing, diagnostics, and quota/policy blocked states', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))
    assert.match(harness.document.querySelector('[data-admin-surface-route="byok"]')?.textContent || '', /Provider keys are never rendered/)

    ;(harness.document.querySelector('#byok-form input[name="providerId"]') as HTMLInputElement).value = 'openai'
    ;(harness.document.querySelector('#byok-form input[name="apiKey"]') as HTMLInputElement).value = 'sk-test-secret'
    harness.submit('#byok-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/byok/openai')))
    await waitFor(() => assert.equal(harness.document.getElementById('status')?.textContent, 'Action complete'))
    assert.doesNotMatch(harness.document.querySelector('#byok-list')?.textContent || '', /sk-test-secret/)

    harness.clickText('[data-route-link]', 'Connections')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'connections'))
    assert.match(harness.document.querySelector('[data-admin-surface-route="connections"]')?.textContent || '', /one-time plaintext reveal/)
    await waitFor(() => assert.ok(harness.document.querySelector('#binding-list > .row')))

    harness.clickText('#gateway-token', 'Gateway token')
    await waitFor(() => {
      const request = harness.lastRequest((entry) => entry.method === 'POST' && entry.path === '/api/api-tokens')
      assert.ok(request)
      assert.deepEqual((request.body as Record<string, unknown>).channelBindingIds, ['binding-1'])
    })
    await waitFor(() => assert.match(harness.document.querySelector('#token-list')?.textContent || '', /Shown once/))
    assert.match(harness.document.querySelector('#token-list')?.textContent || '', /Clear token/)
    assert.match((harness.document.querySelector('#token-list input[readonly]') as HTMLInputElement).value, /occ_created_token_value/)

    ;(harness.document.querySelector('#agent-form input[name="name"]') as HTMLInputElement).value = 'Release helper'
    harness.submit('#agent-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/channels/agents')))

    harness.clickText('[data-route-link]', 'Gateway')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'gateway'))
    assert.match(harness.document.querySelector('[data-admin-surface-route="gateway"]')?.textContent || '', /delivery backlog/)

    ;(harness.document.querySelector('#binding-form input[name="displayName"]') as HTMLInputElement).value = 'Team Slack'
    ;(harness.document.querySelector('#binding-form input[name="credentialRef"]') as HTMLInputElement).value = 'secret://gateway/slack'
    harness.submit('#binding-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/channels/bindings')))

    harness.clickText('#delivery-list button', 'Retry')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/retry$/.test(request.path))))

    assert.match(harness.document.querySelector('#billing-summary')?.textContent || '', /active/)
    assert.match(harness.document.querySelector('#usage-quota-list')?.textContent || '', /Prompts\/hour/)
    assert.match(harness.document.querySelector('#admin-worker-summary')?.textContent || '', /Primary worker pool/)
    assert.match(harness.document.querySelector('#admin-worker-summary')?.textContent || '', /Worker one/)
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/admin/worker-pools?limit=100'))
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/admin/workers?limit=100'))

    const downloads: Blob[] = []
    Object.defineProperty(harness.window.URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        downloads.push(blob)
        return `blob:https://cloud.example.test/export-${downloads.length}`
      },
    })
    harness.clickText('#export-audit', 'Export')
    harness.clickText('#export-usage', 'Export usage')
    await waitFor(() => assert.equal(downloads.length, 2))
    const auditExportText = await readBrowserBlobText(harness, downloads[0])
    const usageExportText = await readBrowserBlobText(harness, downloads[1])
    const auditExport = JSON.parse(auditExportText) as { events?: unknown[] }
    const usageExport = JSON.parse(usageExportText) as { summary?: unknown, events?: unknown[] }
    assert.equal(auditExport.events?.length, 1)
    assert.equal(usageExport.events?.length, 1)
    assert.ok(usageExport.summary)
    assert.doesNotMatch(auditExportText, /leaked-secret|signed\?token=/)
    assert.doesNotMatch(usageExportText, /leaked-secret/)

    harness.clickText('#diagnostics button', 'Prepare bundle')
    await waitFor(() => assert.match(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /secrets-redacted/))
    assert.doesNotMatch(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /sk-test-secret|occ_created_token/)
    harness.clickText('[data-route-link]', 'Diagnostics')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'diagnostics'))
    assert.match(harness.document.querySelector('[data-admin-surface-route="diagnostics"]')?.textContent || '', /recursively redacted/)
  } finally {
    harness.close()
  }

  const billingDisabled = await createCloudWebBrowserHarness({ role: 'admin', billingEnabled: false }).start()
  try {
    await waitFor(() => assert.match(billingDisabled.document.querySelector('#billing-summary')?.textContent || '', /billing disabled/))
    assert.equal((billingDisabled.document.querySelector('#billing-plan-select') as HTMLSelectElement).disabled, true)
    assert.equal((billingDisabled.document.querySelector('#billing-form button[type="submit"]') as HTMLButtonElement).disabled, true)
    assert.equal((billingDisabled.document.querySelector('#billing-portal') as HTMLButtonElement).disabled, true)
    await waitFor(() => assert.match((billingDisabled.document.querySelector('#billing-portal') as HTMLButtonElement).title, /Billing is not available/))
    const billingRequestCount = billingDisabled.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/billing/')).length
    billingDisabled.submit('#billing-form')
    billingDisabled.clickText('#billing-portal', 'Open portal')
    await waitFor(() => assert.match(billingDisabled.document.querySelector('#status')?.textContent || '', /Billing is not available/))
    assert.equal(billingDisabled.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/billing/')).length, billingRequestCount)
  } finally {
    billingDisabled.close()
  }

  const billingBlocked = await createCloudWebBrowserHarness({
    role: 'admin',
    promptFailure: { status: 402, error: 'Billing subscription inactive.' },
  }).start()
  try {
    await waitFor(() => assert.match(billingBlocked.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/))
    ;(billingBlocked.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value = 'Run more work.'
    billingBlocked.submit('#prompt-form')
    await waitFor(() => assert.match(billingBlocked.document.querySelector('#status')?.textContent || '', /Billing subscription inactive/))
  } finally {
    billingBlocked.close()
  }

  const quotaBlocked = await createCloudWebBrowserHarness({
    role: 'admin',
    promptFailure: { status: 429, error: 'Quota exceeded.' },
  }).start()
  try {
    await waitFor(() => assert.match(quotaBlocked.document.querySelector('#chat-session-title')?.textContent || '', /What shall we cowork on today/))
    ;(quotaBlocked.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value = 'Run more work.'
    quotaBlocked.submit('#prompt-form')
    await waitFor(() => assert.match(quotaBlocked.document.querySelector('#status')?.textContent || '', /Quota exceeded/))
  } finally {
    quotaBlocked.close()
  }
})

test('cloud web browser requires typed confirmation for destructive admin actions', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))

    Object.defineProperty(harness.window, 'prompt', { value: () => 'wrong-id', configurable: true })
    harness.clickText('#token-list button', 'Revoke')
    await waitFor(() => assert.match(harness.document.querySelector('#status')?.textContent || '', /Confirmation did not match the token id/))
    assert.equal(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/api-tokens/token-1'), undefined)

    const prompts = ['anthropic', 'token-1', 'acct-2', 'workflow-1', 'delivery-1', 'Operator reviewed the stuck delivery.']
    Object.defineProperty(harness.window, 'prompt', {
      value: () => prompts.shift() || '',
      configurable: true,
    })

    harness.clickText('#byok-list button', 'Disable')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/byok/anthropic')))

    harness.clickText('#token-list button', 'Revoke')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/api-tokens/token-1')))

    const memberRow = [...harness.document.querySelectorAll('#member-list .member-row')]
      .find((row) => row.textContent?.includes('member@example.test'))
    assert.ok(memberRow)
    ;(memberRow.querySelector('button.danger') as HTMLButtonElement).click()
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/admin/members/acct-2/update')))

    harness.clickText('#workflow-detail button', 'Archive')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/workflows/workflow-1/archive')))

    harness.clickText('#delivery-list button', 'Dead-letter')
    await waitFor(() => {
      const request = harness.lastRequest((entry) => entry.method === 'POST' && entry.path === '/api/channels/deliveries/delivery-1/dead-letter')
      assert.ok(request)
      assert.equal((request.body as Record<string, unknown>).lastError, 'Operator reviewed the stuck delivery.')
    })
  } finally {
    harness.close()
  }
})
