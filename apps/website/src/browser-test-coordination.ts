import { iso } from './browser-test-fixtures.ts'

export type BrowserHarnessMockRequest = {
  method: string
  path: string
  pathname: string
  body: unknown
  headers: Record<string, string>
}

type MockSession = {
  sessionId: string
  title: string
  updatedAt: string
}

type JsonResponse = (body: unknown, status?: number) => Response
type LimitFromRequest = (request: BrowserHarnessMockRequest, fallback: number, max?: number) => number

const workspaceId = 'cloud:org-1'

function coordinationBase(id: string, kind: string, updatedIndex: number) {
  return {
    id,
    kind,
    workspaceId,
    ownerAuthority: 'gateway_standalone',
    executionAuthority: 'gateway_standalone',
    stateOwner: 'cloud_control_plane',
    createdAt: iso(updatedIndex),
    updatedAt: iso(updatedIndex),
  }
}

export function makeBrowserCoordinationState(sessions: MockSession[]) {
  const coordinationProjects = [{
    ...coordinationBase('project-1', 'project', 20),
    title: 'Studio parity launch',
    objective: 'Bring Cloud Web project work to the same board-driven experience as Desktop.',
    description: 'Plan, execute, review, and ship the visible Studio surface.',
    status: 'active',
    team: ['chief-of-staff', 'build', 'reviewer'],
    sourceSessionId: sessions[0]?.sessionId || null,
  }]
  const coordinationTasks = [{
    ...coordinationBase('task-1', 'task', 21),
    projectId: 'project-1',
    parentTaskId: null,
    title: 'Audit project surface parity',
    spec: 'Compare Desktop and Cloud Web project routes, then list the gaps that block a board-first workflow.',
    description: 'Audit the visible Projects route before implementation.',
    status: 'completed',
    column: 'done',
    priority: 'high',
    assigneeAgent: 'chief-of-staff',
    assignedRunId: null,
    assignedSessionId: sessions[0]?.sessionId || null,
    artifactRefs: [],
  }, {
    ...coordinationBase('task-2', 'task', 22),
    projectId: 'project-1',
    parentTaskId: null,
    title: 'Implement shared board shell',
    spec: 'Use shared Studio primitives for project cards, kanban columns, task cards, and the run timeline.',
    description: 'Shared primitives first, then platform wiring.',
    status: 'running',
    column: 'doing',
    priority: 'med',
    assigneeAgent: 'build',
    assignedRunId: null,
    assignedSessionId: sessions[0]?.sessionId || null,
    artifactRefs: [],
  }, {
    ...coordinationBase('task-3', 'task', 23),
    projectId: 'project-1',
    parentTaskId: null,
    title: 'Review Cloud API writes',
    spec: 'Verify board move, assign, and Cleo plan actions use only Cloud API-client writes.',
    description: 'No browser-owned execution semantics.',
    status: 'open',
    column: 'review',
    priority: 'low',
    assigneeAgent: 'reviewer',
    assignedRunId: null,
    assignedSessionId: null,
    artifactRefs: [],
  }]
  return { coordinationProjects, coordinationTasks }
}

export function handleBrowserCoordinationRequest(options: {
  request: BrowserHarnessMockRequest
  state: Record<string, any>
  sessions: MockSession[]
  jsonResponse: JsonResponse
  limitFromRequest: LimitFromRequest
}) {
  const { request, state, sessions, jsonResponse, limitFromRequest } = options
  if (request.method === 'GET' && request.pathname === '/api/coordination/board') {
    return jsonResponse({ projects: state.coordinationProjects, tasks: state.coordinationTasks })
  }
  if (request.method === 'GET' && request.pathname === '/api/coordination/projects') {
    return jsonResponse(state.coordinationProjects.slice(0, limitFromRequest(request, 100)))
  }
  if (request.method === 'POST' && request.pathname === '/api/coordination/projects') {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, any>
      : {}
    const project = {
      ...coordinationBase(`project-${state.coordinationProjects.length + 1}`, 'project', 40 + state.coordinationProjects.length),
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New project',
      objective: typeof body.objective === 'string' && body.objective.trim() ? body.objective.trim() : 'Plan the project.',
      description: typeof body.description === 'string' ? body.description : null,
      status: body.status || 'active',
      team: Array.isArray(body.team) ? body.team : [],
      sourceSessionId: typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null,
    }
    state.coordinationProjects = [project, ...state.coordinationProjects]
    return jsonResponse(project, 201)
  }
  const coordinationPlanMatch = request.pathname.match(/^\/api\/coordination\/projects\/([^/]+)\/plan-with-cleo$/)
  if (request.method === 'POST' && coordinationPlanMatch) {
    const projectId = decodeURIComponent(coordinationPlanMatch[1])
    const project = state.coordinationProjects.find((entry: any) => entry.id === projectId)
    if (!project) return jsonResponse({ error: 'Coordination project was not found.' }, 404)
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, any>
      : {}
    const assignees = Array.isArray(body.assigneeAgents) && body.assigneeAgents.length ? body.assigneeAgents : project.team
    const drafts = Array.isArray(body.tasks) && body.tasks.length
      ? body.tasks
      : [
        { title: 'Clarify acceptance criteria', spec: `Turn "${body.objective || project.objective}" into reviewable acceptance criteria.`, priority: 'high', assigneeAgent: assignees[0] || 'chief-of-staff', column: 'planning' },
        { title: 'Execute first implementation pass', spec: 'Create the first linked work session once the task is ready to run.', priority: 'med', assigneeAgent: assignees[1] || assignees[0] || 'build', column: 'backlog' },
      ]
    const tasks = drafts.map((draft: any, index: number) => ({
      ...coordinationBase(`task-${state.coordinationTasks.length + index + 1}`, 'task', 50 + state.coordinationTasks.length + index),
      projectId,
      parentTaskId: null,
      title: draft.title || `Planned task ${index + 1}`,
      spec: draft.spec || 'Planned by Cleo.',
      description: draft.description || null,
      status: 'open',
      column: draft.column || 'backlog',
      priority: draft.priority || 'med',
      assigneeAgent: draft.assigneeAgent || null,
      assignedRunId: null,
      assignedSessionId: null,
      artifactRefs: [],
    }))
    state.coordinationTasks = [...tasks, ...state.coordinationTasks]
    return jsonResponse({ plannerAgent: 'chief-of-staff', displayName: 'Cleo', objective: body.objective || project.objective, project, tasks }, 201)
  }
  if (request.method === 'GET' && request.pathname === '/api/coordination/tasks') {
    const params = new URL(request.path, 'https://cloud.example.test').searchParams
    const projectId = params.get('projectId')
    const tasks = projectId ? state.coordinationTasks.filter((task: any) => task.projectId === projectId) : state.coordinationTasks
    return jsonResponse(tasks.slice(0, limitFromRequest(request, 500)))
  }
  const coordinationMoveMatch = request.pathname.match(/^\/api\/coordination\/tasks\/([^/]+)\/move$/)
  if (request.method === 'POST' && coordinationMoveMatch) {
    const taskId = decodeURIComponent(coordinationMoveMatch[1])
    const column = (request.body as Record<string, unknown> | null)?.column
    state.coordinationTasks = state.coordinationTasks.map((task: any) => task.id === taskId ? { ...task, column, updatedAt: iso(60) } : task)
    return jsonResponse(state.coordinationTasks.find((task: any) => task.id === taskId) || null)
  }
  const coordinationAssignMatch = request.pathname.match(/^\/api\/coordination\/tasks\/([^/]+)\/assign$/)
  if (request.method === 'POST' && coordinationAssignMatch) {
    const taskId = decodeURIComponent(coordinationAssignMatch[1])
    const assigneeAgent = (request.body as Record<string, unknown> | null)?.assigneeAgent || null
    state.coordinationTasks = state.coordinationTasks.map((task: any) => task.id === taskId ? { ...task, assigneeAgent, updatedAt: iso(61) } : task)
    return jsonResponse(state.coordinationTasks.find((task: any) => task.id === taskId) || null)
  }
  const coordinationWorkTargetMatch = request.pathname.match(/^\/api\/coordination\/tasks\/([^/]+)\/work-target$/)
  if (request.method === 'GET' && coordinationWorkTargetMatch) {
    const taskId = decodeURIComponent(coordinationWorkTargetMatch[1])
    const task = state.coordinationTasks.find((entry: any) => entry.id === taskId)
    if (!task?.assignedSessionId) return jsonResponse(null)
    const session = sessions.find((entry) => entry.sessionId === task.assignedSessionId)
    return jsonResponse(session ? {
      id: session.sessionId,
      title: session.title,
      createdAt: session.updatedAt,
      updatedAt: session.updatedAt,
      kind: 'interactive',
    } : null)
  }
  return null
}
