export type TodoLike = { content: string; status: string; priority: string; id?: string }

export type TaskRunLike = {
  id: string
  title: string
  status: 'queued' | 'running' | 'complete' | 'error'
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'deep',
  'for',
  'lets',
  'of',
  'on',
  'the',
  'topic',
  'topics',
  'with',
])

const ACTION_GROUPS = [
  ['research', 'investigate', 'explore'],
  ['analyze', 'analyse', 'review', 'audit'],
  ['create', 'build', 'draft', 'write', 'prepare'],
  ['summarize', 'summary', 'synthesize'],
]

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function significantTokens(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token && (token.length > 2 || token === 'ai' || token === 'mcp'))
    .filter((token) => !STOP_WORDS.has(token))
}

function actionGroup(text: string) {
  const tokens = normalizeText(text).split(' ')
  for (const token of tokens) {
    const group = ACTION_GROUPS.find((entries) => entries.includes(token))
    if (group) return group[0]
  }
  return null
}

function matchScore(todo: TodoLike, taskRun: TaskRunLike) {
  const todoText = normalizeText(todo.content)
  const taskText = normalizeText(taskRun.title)
  if (!taskText) return 0
  if (todoText.includes(taskText) || taskText.includes(todoText)) return 10

  const todoAction = actionGroup(todo.content)
  const taskAction = actionGroup(taskRun.title)
  if (todoAction && taskAction && todoAction !== taskAction) return 0

  const todoTokens = new Set(significantTokens(todo.content))
  const taskTokens = significantTokens(taskRun.title)
  if (!taskTokens.length) return 0

  const overlappingTokens = taskTokens.filter((token) => todoTokens.has(token))
  const overlap = overlappingTokens.length
  if (overlap === 0) return 0

  if (overlap >= 2) return overlap / Math.max(taskTokens.length, 2)

  const [onlyToken] = overlappingTokens
  if (!onlyToken) return 0
  if (onlyToken.length >= 8 && (!todoAction || !taskAction || todoAction === taskAction)) {
    return 0.6
  }

  return 0
}

function derivedStatus(todo: TodoLike, taskRun: TaskRunLike) {
  if (todo.status === 'completed') return todo.status
  if (taskRun.status === 'complete') return 'completed'
  if (taskRun.status === 'queued') return 'pending'
  if (taskRun.status === 'running') return 'in_progress'
  return todo.status
}

export function syncTodosWithTaskRuns(rawTodos: TodoLike[], taskRuns: TaskRunLike[]) {
  if (!rawTodos.length || !taskRuns.length) return rawTodos

  const remainingTaskRuns = [...taskRuns]

  return rawTodos.map((todo) => {
    let bestIndex = -1
    let bestScore = 0

    for (let index = 0; index < remainingTaskRuns.length; index += 1) {
      const taskRun = remainingTaskRuns[index]
      const score = matchScore(todo, taskRun)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }

    if (bestIndex === -1 || bestScore < 0.5) {
      return todo
    }

    const taskRun = remainingTaskRuns.splice(bestIndex, 1)[0]
    const nextStatus = derivedStatus(todo, taskRun)
    if (nextStatus === todo.status) return todo
    return { ...todo, status: nextStatus }
  })
}
